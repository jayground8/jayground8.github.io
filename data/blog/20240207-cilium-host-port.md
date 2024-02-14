---
title: 'Cilium CNI와 HostPort'
date: '2024-02-07'
tags: ['kubernetes', 'cilium']
images: ['/static/images/social-banner.png']
summary: '네이버 클라우드 쿠버네티스 서비스에서 HostPort를 설정하였는데, 정상적으로 Node Port를 통해서 Container에 접근할 수가 없었다. 처음에는 CNI plugin portmap을 설정하여 HostPort를 Iptables Rule로 적용하도록 하였다. 하지만 현재 운영하는 Kernel 버전이 kube proxy를 대체할 수 있는 것을 파악하였고, default로 설정된 KubeProxyReplacement=disabled을 KubeProxyReplacement=strict으로 설정하여 Cilium eBPF로 대체하여 사용하였다.'
---

## 테스트 환경

- 네이버 클라우드 쿠버네티스 서비스 버전: 1.26
- Cilium 버전: 1.10.16
- 커널 버전: 5.4.0-163-generic

## 이슈 사항

OpenTelemetry collector를 DaemonSet으로 설치를 하였다. 그리고 Web server가 돌고 있는 Pod가 Trace 정보를 Collector에 보내고자 했다. OpenTelemetry Collector가 HostPort로 설정이 되어 있었고, Pod는 이 HostPort로 연결을 시도했다.

`opentelemetry collector 설정`

```yaml
Ports: 4317/TCP, 4318/TCP
Host Ports: 4317/TCP, 4318/TCP
```

`Web server가 돌고 있는 Pod의 Deployment 설정`

```yaml
- name: NODE_IP
    valueFrom:
      fieldRef:
        fieldPath: status.hostIP
```

`OpenTelemetry SDK를 통해서 Trace를 전송`

```js
traceExporter: new OTLPTraceExporter({
  url: `http://${process.env.NODE_IP}:4318/v1/traces`,
}),
```

하지만 OpenTelemetry Collector가 정상적으로 실행되고 있었지만, Node에서 해당 collector로 연결하지 못하고 Connection refused가 발생하였다. 네이버 클라우드 쿠버네티스에서 Cilium이 CNI로 설정이 되어 있었고, 아래와 같이 cilium cli를 통해서 service 목록을 확인하였다. 하지만 `HostPort` Service Type은 목록에서 보이지 않았다.

```bash
kubectl exec -it cilium-4d93a -n kube-system -- cilium service list
```

## HostPort

Kubernetes에서 아래와 같이 `HostPort`를 설정하면, Pod가 Node의 Port에서 listening할 수 있다. 아래의 경우는 Node의 8080 Port에 요청하면 Container의 80 Port에 연결할 수 있다. 일반적으로 Iptable의 nat table에 Rule들이 생성되어 이렇게 작동된다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  selector:
    matchLabels:
      run: my-nginx
  replicas: 1
  template:
    metadata:
      labels:
        run: my-nginx
    spec:
      containers:
        - name: my-nginx
          image: nginx
          ports:
            - containerPort: 80
              hostPort: 8080
```

## HostPort with Cilium's eBPF

Cilium은 eBPF로 Kube Proxy를 대체할 수 있다. [Cilium v1.11의 문서](https://docs.cilium.io/en/v1.11/operations/system_requirements/)를 보면, kube proxy를 대체하기 위해서 kernel version이 5.2이상에서 가능하다. 테스트하는 환경은 커널 버전이 5.4이상이니깐 cilium이 eBPF로 kube proxy를 대체할 수 있다.

<img src="/static/images/cilium-required-kernel-version-1.11.png" alt="cilium required kernel version" />

BPF-based host routing은 kernel version 5.10 이상이어야 하는데, 따라서 해당 설정은 cilium agent log를 확인해보면 아래처럼 5.10이 아니라서 `enable-host-legacy-routing`이 자동으로 true로 셋팅되는 것을 확인할 수 있다.

```bash
level=info
msg="BPF host routing requires kernel 5.10 or newer. Falling back to legacy host routing (enable-host-legacy-routing=true)."
subsys=daemon
```

Helm chart로 Cilium을 설치하면 `cilium-config`가 ConfigMap object로 생성되는데, [ConfigMap의 값으로 Cilium의 설정이 결정된다.](https://github.com/cilium/cilium/blob/v1.10.16/install/kubernetes/cilium/templates/cilium-configmap.yaml). 여기서 관심있게 봐야할 설정값은 `kube-proxy-relacement`이다.

[cilium v1.11에서 kubeProxyReplacement을 아래와 같이 네 가지중에 하나로 설정할 수 있다.](https://docs.cilium.io/en/v1.11/gettingstarted/kubeproxy-free/#kube-proxy-hybrid-modes)

- strict: eBPF로 다 대체
- probe: 대체할 수 있는것만 eBPF로 대체하고 나머지는 kube proxy랑 같이 공존
- partial: 원하는 부분만 enable해서 eBPF로 대체
- disabled

그런데 네이버 클라우드 쿠버네티스 서비스의 `cilium-config`의 `kube-proxy-replacement`가 기본으로 disabled로 되어 있었다.

> kubeProxyReplacement=disabled: This option disables any Kubernetes service handling by fully relying on kube-proxy instead, except for ClusterIP services accessed from pods (pre-v1.6 behavior).

`cilium status` CLI 명령어로 확인을 하면, HostPort가 Disabled로 나온다.

```bash
$ kubectl exec -it cilium-4d93a -n kube-system -- cilium status --verbose
...생략
KubeProxyReplacement Details:
  Services:
    - ClusterIP:      Enabled
    - NodePort:       Disabled
    - LoadBalancer:   Disabled
    - externalIPs:    Disabled
    - HostPort:       Disabled
```

## CNI plugin portmap

처음에 `partial` 설정으로 `HostPort`만 Enabled을 해볼려고 하는데 안되었다. 그래서 eBPF로 HostPort가 대체되지 못하는 줄 알았다. 그렇게 또 한번 쓸데 없는 삽질을 하게 되었다.🥹 `KubeProxyReplacement`를 `disabld`로 유지하고, [CNI chaining으로 PortMap을 사용](https://docs.cilium.io/en/latest/installation/cni-chaining-portmap/#portmap-hostport)하는 방법을 적용했다.

`cilium-config` ConfigMap에서 `cni-chaining-mode`를 아래와 같이 설정하고, Opentelemetry Collector를 restart한다.

```yml
apiVersion: v1
kind: ConfigMap
...
data:
  ...생략
  cni-chaining-mode: portmap
```

```bash
kubectl rollout restart daemonset/cilium -n kube-system
```

이렇게 적용하고 나면 `/etc/cni/net.d/05-cilium.conflist`에 cni 설정 파일이 아래와 같이 생성된다. `portmap`이 plugin에 추가된 것을 확인 할 수 있다.

```json
{
  "cniVersion": "0.3.1",
  "name": "portmap",
  "plugins": [
    {
      "name": "cilium",
      "type": "cilium-cni",
      "enable-debug": false
    },
    {
      "type": "portmap",
      "capabilities": { "portMappings": true }
    }
  ]
}
```

이제 다시 HostPort가 설정된 Deployment Object을 생성한다.

```yaml
apiVersion: v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  selector:
    matchLabels:
      run: my-nginx
  replicas: 1
  template:
    metadata:
      labels:
        run: my-nginx
    spec:
      containers:
        - name: my-nginx
          image: nginx
          ports:
            - containerPort: 80
              hostPort: 8080
```

이번에는 아래와 같이 cni plugin `portmap` binary 파일이 없어서 Pod가 정상적으로 실행되지 못 했다.

```log
error killing pod: failed to "KillPodSandbox" for "1055faa0-7449-49ba-9e25-b6e46de342b1" with KillPodSandboxError:
"rpc error: code = Unknown desc = failed to destroy network for sandbox \"79eade222dddaff28fcb79d001a47e581acfc501fe4b1c220c9f99b1415cfae3\":
plugin type=\"portmap\" failed (delete): failed to find plugin \"portmap\" in path [/opt/cni/bin]"
```

Worker Node에 들어가서 cni plugin binary를 확인하니 아래처럼 두 개만 존재하였다.

```bash
$ ls /opt/cni/bin
cilium-cni
loopback
```

그래서 Go를 설치하고 cni plugin 소스코드를 clone하여서 build하여서 `/opt/cni/bin`에 추가해주었다.

```bash
curl -OL https://golang.org/dl/go1.20.4.linux-amd64.tar.gz
sudo tar -C /usr/local -xvf go1.20.4.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
```

```bash
git clone https://github.com/containernetworking/plugins.git
cd plugins
./build_linux.sh
sudo cp bin/portmap /opt/cni/bin/
```

이제 Pod가 정상적으로 작동하고, Iptable에 아래와 같이 Rule이 추가된 것을 확인할 수 있다.🥹 이제 정상적으로 Node에서 8080 포트로 해당 컨테이너에 접근할 수 있게 되었다.

```bash
$ iptables-save | grep HOSTPORT
:CNI-HOSTPORT-DNAT - [0:0]
:CNI-HOSTPORT-MASQ - [0:0]
:CNI-HOSTPORT-SETMARK - [0:0]
-A PREROUTING -m addrtype --dst-type LOCAL -j CNI-HOSTPORT-DNAT
-A OUTPUT -m addrtype --dst-type LOCAL -j CNI-HOSTPORT-DNAT
-A POSTROUTING -m comment --comment "CNI portfwd requiring masquerade" -j CNI-HOSTPORT-MASQ
-A CNI-DN-dae2e2caa00ed8d022728 -s 198.18.2.27/32 -p tcp -m tcp --dport 8080 -j CNI-HOSTPORT-SETMARK
-A CNI-DN-dae2e2caa00ed8d022728 -s 127.0.0.1/32 -p tcp -m tcp --dport 8080 -j CNI-HOSTPORT-SETMARK
-A CNI-HOSTPORT-DNAT -p tcp -m comment --comment "dnat name: \"portmap\" id: \"d629b42b837dcb40bc6a45f2486e76616c72ca15a3dc5cefe2f881ebd0d8222c\"" -m multiport --dports 8080 -j CNI-DN-dae2e2caa00ed8d022728
-A CNI-HOSTPORT-MASQ -m mark --mark 0x2000/0x2000 -j MASQUERADE
-A CNI-HOSTPORT-SETMARK -m comment --comment "CNI portfwd masquerade mark" -j MARK --set-xmark 0x2000/0x2000
```

## eBPF로 대체

뒤늦게 cilium으로 kube proxy를 완전 대체할 수 있는 환경이라는 것이 파악이 되었다. 그래서 아래와 같이 `cilium-config`를 변경하고, cilium agent를 재시작하였다.

```yml
apiVersion: v1
kind: ConfigMap
...
data:
  ...생략
  kube-proxy-replacement: strict
```

```bash
kubectl rollout restart daemonset/cilium -n kube-system
```

재시작하고 cilium status를 확인하면 이제 Service들이 다 Enabled된 것을 확인할 수 있다.

```bash
$ kubectl exec -it cilium-tpxvv -- cilium status --verbose
...생략
KubeProxyReplacement Details:
  Status:                Strict
  Socket LB Protocols:   TCP, UDP
  Devices:               eth0 192.168.1.10 (Direct Routing)
  Mode:                  SNAT
  Backend Selection:     Random
  Session Affinity:      Enabled
  XDP Acceleration:      Disabled
  Services:
  - ClusterIP:      Enabled
  - NodePort:       Enabled (Range: 30000-32767)
  - LoadBalancer:   Enabled
  - externalIPs:    Enabled
  - HostPort:       Enabled
```

이제 다시 HostPort가 설정된 Deployment Object를 배포하고, 아래와 같이 Cilium service 목록을 확인해본다. 그러면 우리가 hostPort 8080, container 80 설정했던 것이 등록되는 것을 확인할 수 있다.

```bash
$ kubectl exec -it cilium-tpxvv -n kube-system -- cilium service list
159   192.168.1.10:8080      HostPort       1 => 198.18.0.24:80
160   0.0.0.0:8080           HostPort       1 => 198.18.0.24:80
```

`partial`의 경우에는 아래처럼 `externalIPs`만 false로 설정하면 그것만 Disabled할 수도 있다.

```yml
apiVersion: v1
kind: ConfigMap
...
data:
  ...생략
  kube-proxy-replacement: partial
  enable-remote-node-identity: "true"
  enable-external-ips: "false"
  enable-host-port: "true"
  enable-health-check-nodeport: "false"
```

```bash
KubeProxyReplacement Details:
  Status:              Partial
  Devices:             eth0 192.168.1.10 (Direct Routing)
  Mode:                SNAT
  Backend Selection:   Random
  Session Affinity:    Enabled
  XDP Acceleration:    Disabled
  Services:
  - ClusterIP:      Enabled
  - NodePort:       Enabled (Range: 30000-32767)
  - LoadBalancer:   Enabled
  - externalIPs:    Disabled
  - HostPort:       Enabled
```

그런데 처음에 portmap을 사용해서 Iptabls rule이 생겼고, HostPort를 사용하는 Pod가 있는 상태에서 Cilium의 eBPF로 대체하도록 수정하였다. 그래서 기존 Iptables rule이 Pod가 삭제될 때 같이 삭제되지 않았다. 그래서 HostPort 설정관련 Iptable rule들이 남아 있었다. eBPF로 사용할 때는 Iptable rule이 있어도 상관없었지만, 테스트를 위해서 다시 portmap을 사용하여 Iptables을 쓸려고 할 때 기존 Iptables rule과 충돌이 생겼다.

## 결론

처음에 `HostPort` 기능만 사용하려고 `kube-proxy-replacement`를 `partial`로 하고 `enable-host-port`를 `true`로 설정했다. 하지만 cilium의 status에서 HostPort가 Enabled로 변경되지 않고 계속 Disabled 상태로 남아 있었다. 문서를 잘 못 읽고 커널 버전이 낮아서 지원을 안하는 줄 착각했다. 그래서 `chainMode`로 `portmap`을 사용하여 테스트를 하게 되었는데, `cilium-config` ConfigMap을 수정하는 것뿐만 아니라, portmap plugin binary는 Worker node에 없어서 해당 source code를 build해서 binary 파일을 적절한 경로에 넣어주는 작업까지 해줘야했다. 네이버 클라우드 쿠버네티스 서비스에서는 Custom Image를 제공하지 않기 때문에, 이렇게 해야 되는 것이 너무 불편하다고 생각했다. 하지만 내가 문서를 잘 못 읽었던 것이고, `enable-host-port`가 `enable-node-port`와 함께 설정될 때 Enabled이 되었다. 해당 Worker Node 환경에서 `strict` 설정으로 kube proxy를 Cilium eBPF로 대체해도 문제가 없었다. `cilium-config`의 `kube-proxy-replacement`을 `probe` 혹은 `strict`로 설정하면 간단하게 해결될 수 있는 문제였다. 🤪
