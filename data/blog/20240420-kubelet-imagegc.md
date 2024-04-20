---
title: 'Kubelet imageGC'
date: '2024-04-20'
tags: ['kubernetes', 'ncloud']
images: ['/static/images/social-banner.png']
summary: '사이즈가 큰 컨테이너 이미지를 내려받기 위해서 Containerd의 설정값 root을 새로운 스토리지를 추가한 경로로 수정하였다. Kubelet은 imageGCHighThresholdPercent로 설정된 임계치보다 disk 사용량이 많으면, 컨테이너 이미지를 정리하여 disk 공간을 확보하려고 한다. imageGCHighThresholdPercent이 기본값으로 85로 설정되어 있고, disk의 85 퍼센트 이상 사용했을 때 정리 프로세스가 실행된다. 문제는 Containerd root 경로의 volume이 거의 꽉 차더라도, 전체 volume의 사용량은 85 퍼센트가 되지 않을 수 있다는 것이다. Containerd root 경로의 volume에 여유가 없어서 새로 스케쥴된 Pod의 컨테이너 이미지를 내려 받지 못하는 문제가 발생할 수 있다. imageGCHighThresholdPercent 설정값을 조절하여 이 문제를 해결할 수 있다.'
---

## 크기가 큰 컨테이너 이미지를 사용

네이버 클라우드의 쿠버네티스 워커 노드의 스토리지 크기가 50GB로 설정되어 있다. 그렇기 때문에 10~20GB 크기의 컨테이너 이미지를 실행하려면 디스크 용량이 부족하게 된다. 용량 부족을 해결하기 위해서 블록 스토리지를 워커노드에 추가 생성하고, 새로 생성한 스토리지를 마운팅한 경로에 컨테이너 이미지를 저장하도록 Containerd 설정파일을 수정하여 해결할 수 있다.

[containerd의 문서](https://github.com/containerd/containerd/blob/main/docs/ops.md)를 확인하면 root 경로 옵션은 컨테이너 이미지를 저장하는 경로로 사용되는 것을 확인할 수 있다.

> root will be used to store any type of persistent data for containerd. Snapshots, content, metadata for containers and image, as well as any plugin data will be kept in this location.

워커노드의 containerd의 설정파일 root을 추가한 Volume의 경로로 수정하고, `systemctl restart containerd`로 재시작하여 적용할 수 있다.

`/etc/containerd/config.toml`
```bash
version = 2
root = "{추가한 경로}"
state = "/run/containerd"
oom_score = 0

...생략
```

이제 아래와 같이 컨테이너 이미지를 pull 받으면, `root`에 설정된 경로로 사용된 용량이 증가하는 것을 확인할 수 있다. 

```bash
ctr -n k8s.io image pull --user {ncloud access key}:{ncloud secret key} {conatiner registry 주소}
```

```bash
$ df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/xvdb        98G   37G   57G  40% {추가한 경로}
```

## Kubelet의 컨테이너 이미지 정리

쿠버네티스에서 Kubelet은 disk 사용량을 체크하여 불필요한 데이터를 제거한다. 그 중에 `image manager`는 disk를 특정 퍼센트 만큼 사용하면, 정리 가능한 컨테이너 이미지를 정리하여 disk 공간을 확보하게 된다.

Systemd로 실행중인 Kubelet process의 설정파일을 확인해보면, 아래와 같이 되어 있다.

```bash
$ systemctl cat kubelet

# /etc/systemd/system/kubelet.service
[Unit]
Description=Kubernetes Kubelet Server
Documentation=https://github.com/GoogleCloudPlatform/kubernetes
After=containerd.service
Wants=containerd.service

[Service]
EnvironmentFile=-/etc/kubernetes/kubelet.env
ExecStart=/usr/local/bin/kubelet \
                $KUBE_LOGTOSTDERR \
                $KUBE_LOG_LEVEL \
                $KUBELET_API_SERVER \
                $KUBELET_ADDRESS \
                $KUBELET_PORT \
                $KUBELET_HOSTNAME \
                $KUBELET_ARGS \
                $DOCKER_SOCKET \
                $KUBELET_NETWORK_PLUGIN \
                $KUBELET_VOLUME_PLUGIN \
                $KUBELET_CLOUDPROVIDER
Restart=always
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

그리고 `/etc/kubernetes/kubelet.env`를 확인해보면, `/etc/kubernetes/kubelet-config.yaml`를 설정값으로 사용하는 것을 확인할 수 있다.

`/etc/kubernetes/kubelet.env`
```bash
...생략
KUBELET_ARGS="--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf \
--config=/etc/kubernetes/kubelet-config.yaml \
--cloud-provider=external \
--provider-id='navercloudplatform://2767456' \
--kubeconfig=/etc/kubernetes/kubelet.conf \
--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock \
--runtime-cgroups=/system.slice/containerd.service \
--node-labels=ncloud.com/nks-nodepool=example \
 --register-with-taints=nvidia.com/gpu=:NoSchedule  "
KUBELET_VOLUME_PLUGIN="--volume-plugin-dir=/usr/libexec/kubernetes/kubelet-plugins/volume/exec"
KUBELET_CLOUDPROVIDER=""

PATH=/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

`/etc/kubernetes/kubelet-config.yaml`는 `KubeletConfiguration` kind로 Kubelet의 설정 parameter 값들을 정의하고 있다.

`/etc/kubernetes/kubelet-config.yaml`
```bash
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
nodeStatusUpdateFrequency: "10s"
failSwapOn: True
authentication:
  anonymous:
    enabled: false
  x509:
    clientCAFile: /etc/kubernetes/ssl/ca.crt
  webhook:
    enabled: true
authorization:
  mode: Webhook
staticPodPath: /etc/kubernetes/manifests
cgroupDriver: systemd
containerLogMaxFiles: 5
containerLogMaxSize: 10Mi
maxPods: 110
address: 
readOnlyPort: 0
healthzPort: 10248
healthzBindAddress: 127.0.0.1
kubeletCgroups: /system.slice/kubelet.service
clusterDomain: cluster.local
protectKernelDefaults: true
rotateCertificates: true
tlsCertFile: /etc/kubernetes/kubelet-server.crt
tlsPrivateKeyFile: /etc/kubernetes/kubelet-server.key
clusterDNS:
evictionHard:
  memory.available: 100Mi
  nodefs.available: 10%
  nodefs.inodesFree: 5%
  pid.available: 10%
kubeReserved:
  cpu: 80m
  memory: 2877Mi
resolvConf: "/run/systemd/resolve/resolv.conf"
featureGates:
  CSIVolumeHealth: true
tlsCipherSuites:
eventRecordQPS: 5
shutdownGracePeriod: 60s
shutdownGracePeriodCriticalPods: 20s
```

위에 명시적으로 정의되어 있지 않지만, 언제 `image manager`가 컨테이너 이미지를 정리할지 정하는 파라미터 값인 `imageGCHighThresholdPercent`와 `imageGCLowThresholdPercent`이 존재한다. 디스크 사용량이 `imageGCHighThresholdPercent` 퍼센트보다 높아지면, `imageGCLowThresholdPercent` 퍼센트까지 디스크 사용량을 줄이기 위해서 컨테이너 이미지를 정리하려고 한다. 해당 설정값은 default로 각각 85, 80으로 설정되어 있다. 따라서 disk 사용량이 85 퍼센트를 넘어가면 컨테이너 이미지를 정리하여 disk 사용량을 줄이는 작업을 하게 된다.

## 컨테이너 이미지가 정리되지 않고 꽉 차는 문제

위에서 containerd의 설정값 `root`를 변경하여, 컨테이너 이미지가 해당 volume에 저장하도록 설정하였다. 예를 들어서 추가 스토리지를 100GB로 설정했다면, 최종 disk 용량은 150GB(기본 50GB + 추가 100GB)가 된다. `imageGCHighThresholdPercent`의 기본 설정값 85 퍼센트가 되려면, 128GB이상을 사용해야 한다. 

문제는 컨테이너 이미지를 저장하는 root 경로의 100GB 용량이 거의 꽉 차더라도, 기본 50GB volume에 여유가 있으면 컨테이너 이미지를 정리하려는 프로세스가 trigger되지 않는다. 예를 들어서 컨테이너 이미지가 계속 쌓여서 100GB중에 95GB를 사용하게 되었지만, 기본 volume 50GB중에 15GB만 쓰고 있다면 전체 disk 사용량은 약 73 퍼센트가 된다. 그래서 disk 공간이 부족해서 Pod가 정상적으로 실행될 수 없는 문제를 발생하게 된다.

따라서 이런 경우에 `/etc/kubernetes/kubelet-config.yaml`에 설정값을 명시적으로 설정하여 컨테이너 이미지가 정리 될 수 있도록 조정이 필요하다. 아래와 같이 설정하고, systemd 명령어로 kubelet service를 재시작한다. `systemctl restart kubelet` 

```bash
imageGCHighThresholdPercent: 60
imageGCLowThresholdPercent: 40
```

이제 Kubelet 로그를 확인하면, 임계치를 넘어서 image를 정리하는 것을 확인할 수 있다.

```bash
sudo journalctl -u kubelet.service -n 100
```

```bash
Disk usage on image filesystem is over the high threshold, trying to free bytes down to the low threshold" usage=93 highThreshold=60 amountToFree=55522593996 lowThreshold=40
```

## 결론

Container Image를 최대한 작게 구성하는 것이 Best Practice이다. 하지만 어쩔 수 없이 10GB가 넘는 Container Image를 네이버 클라우드 쿠버네티스 서비스에서 띄울려고 할 때, Disk 크기가 문제가 될 수 있다. 기본 Block Storage 50GB만 제공하기 때문에 Kubelet에 지정된 Disk 최대치를 넘어가서 Pod가 스케쥴링이 안되는 문제가 발생할 수 있거나, Container Image를 정상적으로 pull 받을 수 없어서 장애가 발생할 수 있다. 따라서 Containerd의 설정값을 변경하여 Container Image가 저장되는 경로를 새로 Mount한 Volume으로 지정하여 사용할 수 있다. 그리고 Image manager가 disk 공간을 유지할 수 있도록 `imageGCHighThresholdPercent`, `imageGCLowThresholdPercent`를 조절할 수 있다.