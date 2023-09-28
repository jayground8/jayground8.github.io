---
title: 'ECR Credential-Provider 사용해보기'
date: '2023-09-28'
tags: [kubernetes]
summary: 'Kubeadm으로 만든 Kubernetes Cluster에서 AWS ECR를 private container image repository를 사용하고자 하였다. private repository를 접근하기 위해서 Kubernetes 1.26부터 stable feature로 제공하는 kubelet crendential provider를 사용하였다.'
---

## CronJob을 이용?

자체적으로 EC2(Ubuntu 20.04)에 Kubernetes Cluster를 Kubeadm로 만들어서 사용하는데, ECR를 연결하여 사용하려고 했다. AWS cli 명령어 `aws ecr get-login-password`를 사용하여 Docker secret에 추가하여 인증할 수도 있다. [Kubernetes 공식문서](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/#create-a-secret-by-providing-credentials-on-the-command-line)에 친절하게 나와 있다. 하지만 이렇게 `aws ecr get-login-password`로 받은 token은 12시간동안 유효하게 된다. 따라서 Cronjob을 만들어서 주기적으로 업데이트해주는 작업으로 해결한 블로그들을 여럿 보았다.

## Kubelet Crendential Provider를 사용

하지만 좀 더 깔끔한 방법이 있을 것 같아서 찾아보는 과정에서 1.26부터 stable된 [kubelet image credential provider 설정](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-credential-provider/)을 발견하게 되었다.

이 기능을 사용하기 위해서는 아래처럼 두가지의 kubelet flag를 설정해줘야 한다.
`--image-credential-provider-config`
`--image-credential-provider-bin-dir`

### Kubelet flag 설정

kubeadm을 사용했기 때문에 kubelet systemd service 설정값을 보면 아래처럼 환경변수 값을 가져오는 것을 확인할 수 있다.

```bash
systemctl status kubelet
```

```bash
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/lib/systemd/system/kubelet.service; enabled; vendor preset: enabled)
    Drop-In: /usr/lib/systemd/system/kubelet.service.d
             └─10-kubeadm.conf
```

```bash
cat /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf
```

```bash
Service]
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
# This is a file that "kubeadm init" and "kubeadm join" generates at runtime, populating the KUBELET_KUBEADM_ARGS variable dynamically
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
# This is a file that the user can use for overrides of the kubelet args as a last resort. Preferably, the user should use
# the .NodeRegistration.KubeletExtraArgs object in the configuration files instead. KUBELET_EXTRA_ARGS should be sourced from this file.
EnvironmentFile=-/etc/sysconfig/kubelet
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

나는 여기에 추가해야 되는 flag 두 개를 넣어줘서 테스트를 하게 되었다.

```bash
cat /var/lib/kubelet# cat kubeadm-flags.env
```

```bash
KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9
```

### plugin binary 설정

`--image-credential-provider-bin-dir`에서 plugin binary file 경로를 가르켜야 하는데, go로 source code를 compile하였다. 그리고 binary file을 `/usr/local/bin`으로 이동하였다.

```bash
curl -OL https://go.dev/dl/go1.20.8.linux-amd64.tar.gz
sudo tar -C /usr/local -xvf go1.20.8.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
git clone https://github.com/kubernetes/cloud-provider-aws.git
cd cloud-provider-aws/cmd/ecr-credential-provider
go build
mv ecr-credential-provider /usr/local/bin
```

### config file 설정

그리고 `--image-credential-provider-config`에 연결한 config 파일도 작성하였다.

`ecr.yml`

```yaml
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
  - name: ecr-credential-provider
    matchImages:
      - '*.dkr.ecr.*.amazonaws.com'
      - '*.dkr.ecr.*.amazonaws.com.cn'
      - '*.dkr.ecr-fips.*.amazonaws.com'
      - '*.dkr.ecr.us-iso-east-1.c2s.ic.gov'
      - '*.dkr.ecr.us-isob-east-1.sc2s.sgov.gov'
    apiVersion: credentialprovider.kubelet.k8s.io/v1
    defaultCacheDuration: '12h'
```

준비가 되어서 `/var/lib/kubelet# cat kubeadm-flags.env`를 아래와 같이 수정하였다.

```bash
KUBELET_KUBEADM_ARGS="--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9 --image-credential-provider-config=/home/ubuntu/ecr.yml --image-credential-provider-bin-dir=/usr/local/bin/"
```

### ECR pull 권한

최소한의 권한만 주는게 Best practice지만 일단 Read쪽 권한 전부와 `GetAuthorizationToken`를 추가하여 테스트를 진행했다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VisualEditor0",
      "Effect": "Allow",
      "Action": [
        "ecr:GetRegistryPolicy",
        "ecr:DescribeImageScanFindings",
        "ecr:GetLifecyclePolicyPreview",
        "ecr:GetDownloadUrlForLayer",
        "ecr:DescribeRegistry",
        "ecr:DescribePullThroughCacheRules",
        "ecr:DescribeImageReplicationStatus",
        "ecr:GetAuthorizationToken",
        "ecr:ListTagsForResource",
        "ecr:ListImages",
        "ecr:BatchGetRepositoryScanningConfiguration",
        "ecr:GetRegistryScanningConfiguration",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetRepositoryPolicy",
        "ecr:GetLifecyclePolicy"
      ],
      "Resource": "*"
    }
  ]
}
```

### kubelet restart

이제 새로운 flag가 적용되도록 restart를 하면 정상적으로 ECR에서 image를 pull해온다. 😎

```bash
sudo systemctl daemon-reload && sudo systemctl restart kubelet
```
