---
title: 'Cilium CNI와 HostPort'
date: '2024-02-07'
tags: ['kubernetes', 'cilium']
images: ['/static/images/social-banner.png']
summary: '네이버 클라우드 쿠버네티스 서비스에서 HostPort를 설정하였는데, 정상적으로 Node Port를 통해서 Container에 접근할 수가 없었다. Cilium의 기본 설정으로는 HostPort를 지원하지 않았다. Cilium은 eBPF로 HostPort가 동작하도록 지원하는데, 이 기능을 사용하도록 Cilium 설정을 변경했다. 하지만 Worker Node의 커널 버전이 필수 버전보다 낮아서 이 기능을 사용할 수 없었다. 그래서 최종적으로 chainMode를 통해서 portmap CNI plugin을 사용하도록 설정을 하였다. 이번에는 portmap binary file이 Worker Node에 기본적으로 없어서 소스코드로 build해서 집어 넣었다. 최종적으로 Iptable Rule을 통해서 Port binding이 적용된 것을 확인하였다.'
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

Cilium을 CNI로 사용할 때 Linux Kernel의 버전에 따라서 Iptable를 이용하는 kube-proxy를 대체할 수 있는 부분이 있고, 없는 부분이 있다. [문서](https://docs.cilium.io/en/stable/operations/system_requirements/#required-kernel-versions-for-advanced-features)를 보면 아래와 같이 설명이 되어 있다. `BPF-based host routing`을 기능을 사용하기 위해서는 Kernel 버전이 최소 `5.19` 이상이어야 하는 것을 알 수 있다.

<img src="/static/images/cilium-required-kernel-version.png" alt="cilium required kernel version" />

Helm chart로 Cilium을 설치하면 `cilium-config`가 ConfigMap object로 생성되는데, [ConfigMap의 값으로 Cilium의 설정이 결정된다.](https://github.com/cilium/cilium/blob/v1.10.16/install/kubernetes/cilium/templates/cilium-configmap.yaml). [Cilium eBPF kube-proxy가 HostPort도 대체할 수 있는데,](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/#container-hostport-support) HostPort와 관련된 설정값은 아래와 같다.

```yaml
kube-proxy-replacement:  {{ $kubeProxyReplacement | quote }}
{{- if hasKey .Values "hostPort" }}
{{- if eq $kubeProxyReplacement "partial" }}
  enable-host-port: {{ .Values.hostPort.enabled | quote }}
{{- end }}
{{- end }}
```

`kube-proxy-relacement` 설정값을 `true`로 설정해서 모든 부분을 대체할 수도 있고, `kube-proxy-relacement`을 `partial`로 설정하여 개별적으로 설정을 할 수 있다. 나는 HostPort부분만 대체하기 위해서 아래와 같이 `cilium-config`를 수정하고, Daemonset으로 돌고 있는 `cilium agent`를 restart했다.

```yml
apiVersion: v1
kind: ConfigMap
...
data:
  ...생략
  kube-proxy-replacement: partial
  enable-host-port: "true"
```

```bash
kubectl rollout restart daemonset/cilium -n kube-system
```

하지만 `cilium status` CLI 명령어로 확인을 하면, HostPort가 Disabled로 나온다.

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

그래서 `cilium agent`의 log을 확인해보니 아래와 같이 남아 있었다. HostPort를 eBPF로 대체하기 위한 시스템 requirement가 맞지 않으면 자동으로 기존 kube-proxy를 사용하도록 설정이 된다. 위에서 설명한 것처럼 Linux Kernel 버전이 낮아서 `cilium-config`로 HostPort를 Cilium의 eBPF로 대체하려고 설정해도 자동으로 disable 되었던 것이다.

```bash
level=info
msg="Auto-disabling \"enable-node-port\", \"enable-external-ips\", \"enable-host-reachable-services\", \"enable-host-port\", \"enable-session-affinity\" features and falling back to \"enable-host-legacy-routing\""
subsys=daemon
```

## HostPort with portmap plugin

Cilium의 eBPF를 사용하기 위해서 System 사양을 다 맞추는 대신에 [CNI chaining으로 PortMap을 사용](https://docs.cilium.io/en/latest/installation/cni-chaining-portmap/#portmap-hostport)할 수 있었다.

`cilium-config` ConfigMap에서 `cni-chaining-mode`를 아래와 같이 설정하고, Opentelemetry Collector를 restart한다.

```yml
apiVersion: v1
kind: ConfigMap
...
data:
  ...생략
  cni-chaining-mode: portmap
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

## 결론

이번에도 간단하게 끝날줄 알았던 작업에서 삽질을 하게 되었다.😭 네이버 클라우드 쿠버네티스 서비스에서는 Node pool를 Custom Image로 설정할 수가 없다. 따라서 기존 Node Image에서 시스템 변경사항이 있으면 그것을 반영하여 Custom Image를 만드는 대신에 Init Script로 변경사항을 반영해야 한다. 그래야지 Node Pool에서 새로운 Node가 시작될 때 변경된 사항을 자동으로 적용할 수 있다. Cilium을 CNI로 Default로 사용하도록 설정되어 있는 상황에서 HostPort가 현재 시스템에서 정상적으로 동작하도록 설정이 안되어 있는 이유가 무엇일까?🤔
