---
title: 'k8s-device-plugin으로 NVIDIA GPU Multi-Process Service 사용하기'
date: '2024-03-24'
tags: ['kubernetes', 'ncloud']
images: ['/static/images/social-banner.png']
summary: 'Kubernetes에서 k8s-device-plugin을 통해서 NVIDIA GPU 자원을 쉽게 사용할 수 있다. 하나의 어플리케이션에서 GPU 자원을 온전히 사용하지 못하고 낭비될 때, Time slicing, MPS, MIG 등을 사용하여 여러 프로세스가 GPU 자원을 공유하도록 설정할 수 있다. 네이버 공공 클라우드에서 Tesla T4와 Telsa V100을 제공한다. 해당 GPU 아키텍쳐가 MIG을 지원히지 않기 때문에, MPS를 적용하여 GPU 자원을 공유하는 것을 고려하였다. 최근에 release된 k8s-device-plugin v0.15.0-rc.1부터 MPS가 지원되기 시작되어 해당 버전으로 MPS를 설정해보았다.'
---

## 네이버 공공 클라우드에서 사용할 수 있는 옵션

NVIDIA GPU는 자원을 공유하기 위한 방법으로 아래와 같은 방법들을 제공한다.
- Time slicing
- Multi-Process Service
- Multi-instance GPU

네이버 공공 클라우드에서 사용한 가능한 GPU에는 Tesla V100(arch: Volta)과 Tesla T4(arch: Turing)가 있다. Hardware단에서 Partition을 하여 격리할 수 있는 `MIG(Multi-instance GPU)`는 `A100`과 같은 `Ampere` 아키텍쳐에서 가능하다. 따라서 T4와 V100에서는 `MIG`를 사용할 수가 없다. 대신에 `MPS(Multi-Process Service)`는 T4와 V100 모두에서 사용이 가능하다. `Time slicing` 방식은 GPU를 많이 사용하는 다수의 프로세스가 공유해서 사용할 때, Context Switch에 의한 overload가 상당히 발생할 수 있다. 반면에 `MPS`는 하나의 Cuda Context를 공유하기 때문에, `Time slicing`보다 Context switch에 대한 overload를 줄일 수 있다. 하지만 이렇게 하나의 Cuda Context를 공유하기 때문에 error가 발생했을 때 모든 MPS client에 영향을 미칠 수 있다. ([Volta MPS에서는 좀 제한적인 영향을 미치는 것 같다.](https://docs.nvidia.com/deploy/mps/index.html#topic_3_3_3_2))

## k8s-device-plugin

Kubernetes에서 GPU를 kubelet이 인지하고 사용할 수 있도록, [NVIDIA에서 공식적으로 device plugin](https://www.youtube.com/watch?v=Q2GuTUO170w&t=922s)을 제공하고 있다. 그리고 Helm chart를 같이 제공한다. 따라서 Helm으로 `k8s-device-plugin`을 설치를 했다.


```bash
helm repo add nvdp https://nvidia.github.io/k8s-device-plugin
```

원하는 Worker node에 Daemonset이 실행될 수 있도록 `affinity`와 `tolerations` 설정을 추가하였다.

`values.yml`
```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
          - key: serverType
            operator: In
            values:
              - gpu
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
```

그리고 device plugin 설정파일에 MPS 설정을 추가하였다.

`config.yaml`
```yaml
version: v1
sharing:
  mps:
    resources:
    - name: nvidia.com/gpu
      replicas: 10
```

NVIDIA의 k8s-device-plugin에서 `v0.15.0`부터 MPS를 지원하기 시작했다. 지금 이 글을 쓰는 시점에 `v0.15.0-rc.2`가 최신 버전이고, 아직 `rc` 환경으로 제공되고 있다. 따라서 Helm으로 설치를 할 때 아래와 같이 version flag를 통해서 0.15.0-rc.2를 설정해준다.

```bash
helm install k8s-device-plugin nvdp/nvidia-device-plugin \
--version 0.15.0-rc.2 \
--namespace nvidia-device-plugin \
--create-namespace \
--values values.yaml \
--set-file config.map.config=config.yaml
```

Helm으로 설치하고 나면 아래와 같이 두개의 Daemonset Object가 만들어진 것을 확인할 수 있다. Deamonset k8s-device-plugin-nvidia-device-plugin-mps-control-daemon가 실행되기 위해서는 Worker Node에 nvidia.com/mps.capable=true가 설정되어야 한다.

```bash
$ kubectl get ds -n nvidia-device-plugin
NAMESPACE              NAME                                                        DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR
nvidia-device-plugin   k8s-device-plugin-nvidia-device-plugin                      1         1         1       1            1           <none>                        5s
nvidia-device-plugin   k8s-device-plugin-nvidia-device-plugin-mps-control-daemon   0         0         0       0            0           nvidia.com/mps.capable=true   5s
```

해당 Label때문에 MPS daemon이 실행되지 못했고, 그래서 k8s-device-plugin-nvidia-device-plugin Pod에 아래와 같은 에러 로그가 남게 되었다.

```bash
Failed to start plugin: error waiting for MPS daemon: error checking MPS daemon health: failed to send command to MPS daemon: exit status 1
```

이제 GPU worker node에 label을 추가해주면 MPS daemon이 실행되고, 정상적으로 MPS가 적용된다.

```bash
kubectl label node gpu-node nvidia.com/mps.capable=true
```

MPS에서 replica를 10으로 설정했기 때문에, Node의 nvida.com/gpu 자원을 확인하면 1에서 10으로 증가한 것을 확인할 수 있다.

```bash
$ kubectl describe node gpu-node
Allocatable:
  cpu:                3920m
  ephemeral-storage:  47267522073
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             17413608Ki
  nvidia.com/gpu:     10
  pods:               110
```

해당 노드에 `nvida.com/gpu` resource request가 1인 Pod 하나만 스케쥴링이 될 수 있었는데, 이제 10으로 늘어나서 다수의 Pod를 해당 노드에서 실행할 수 있게 되었다.

