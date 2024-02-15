---
title: 'Tekton Chain'
date: '2024-02-11'
tags: ['kubernetes', 'tekton', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'Kubernetes에서 Tekton Chain을 통해서 어떻게 Software Supply Chain Security를 구성할 수 있는지 확인했다. Tekton Pipeline으로 git clone을 하고, container image를 build하고, 최종적으로 OCI registry에 push하도록 구성했다. 그리고 Tekton Chain이 어떻게 in-toto spec의 Attestation 정보를 남기는지 확인하였다.'
---

Tekton Chain은 Tekton으로 Pipeline을 운영할 때, Supply Chain Security를 쉽게 관리할 수 있도록 해주는 Kubernetes controller이다. Tekton Chain을 이해하기 위해 알아야 할 용어들을 먼저 살펴보고, Tekton Chain을 사용하여 Container Registry에 Attestation 정보를 남겨보자.

## Software Supply Chain Security

다양한 공급업체에서 만들어진 부품들이 모여서 완성차가 만들어지게 되는데, 사용된 부품 중에 일부에 결함이 생겨도 완성차에 안전 문제를 야기할 수 있다. 소프트웨어도 마찬가지로 다양한 Library, Package, Tool들이 합쳐져 최종 결과물이 만들어지게 된다. 이렇게 의존성을 가지는 다양한 소스에서 소프트웨어의 보안 이슈를 가져올 수 있다. [CNCF In-Toto에 대해서 발표한 세션](https://www.youtube.com/watch?v=XHW3pxXg_dc&t=1240s)에서 Cloud Native Application에서 어떻게 Software Supply Chain 보안을 가져갈 수 있을지 `In-Toto` 프로젝트와 함께 설명한다. Git으로부터 Source code를 가져오고, Compile하여 최종적으로 package를 publish하는 pipeline를 예를 들어서 생각해보자. 우리가 public repository에서 소스 코드를 받아 올 때, 해커에 의해서 해당 repository가 다른 쪽으로 Mirror가 되어 조작된 소스코드를 받을 수도 있다. 마찬가지로 Package manager도 해커에 의해서 다른 곳에서 변경된 package를 받아서 사용하게 될 수 있다. 발표에서 설명한 `In-Toto` 프로젝트를 통한 해결책은 각 단계마다 출처를 남기고 그것을 통해서 믿을 수 있는 프로세스를 구축하는 것이다. 예를 들어서 소스코드는 어떤 repository URL에서 어떤 commit을 사용했고, signing commit으로 어떤 public key로 확인할 수 있는지 정보를 남긴다. Build단계에서는 compiler의 종류, 버전, 사용된 명령어에 대한 정보들을 남길 수 있을 것이다. 이러한 각 단계의 정보들을 연결한 메타데이터를 최종 결과물과 함께 같이 보관한다. 사용자는 최종 결과물과 같이 저장된 메타데이터를 통해서 간 단계마다 출처를 확인하고 출처를 증명할 수 있게 된다.

## In-Toto Attestation

[In-toto Attestation Framework](https://github.com/in-toto/attestation)는 어떤 정보를 남겨야하는지 규격을 제공한다. [attestation layer v1 규격]
(https://github.com/in-toto/attestation/tree/main/spec/v1)을 확인해보면 아래와 같은 용어가 설명되어 있다.

- Envelope: Handles authentication and serialization
- Statement: Binds the attestation to a particular subject and unambiguously identifies the types of the predicate
- Predicate: Contains arbitrary metadata about a subject artifact, with a type-specific schema.

Tekton Chain으로 생성되는 데이터를 확인하면, 먼저 아래와 같이 Envlope이라는 규격 정의를 볼 수 있다. `payloadType`에서 `json`형식으로 정의가 되었고, `payload`는 base64로 인코딩 된 값이 들어가 있다.

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "{base64 encoded payload}"
}
```

Envelope 설명에 `Handles authentication`이라고 되어 있다. Tekton Chain에서 Envelope 데이터를 저장할 때 아래와 같이 signing을 하고 signature을 같이 남기게 된다. signatures은 Envelope 규격에 정의되어 있는 field는 아니지만, Envelope을 siging하고 verify하기 때문에 `Handles authentication`이라고 설명해놓은거 아닐까 생각한다.

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "{base64 encoded payload}",
  "signatures": [
    {
      "keyid": "",
      "sig": ""
    }
  ]
}
```

이제 Envelope의 `payload` 값을 디코딩하면 아래와 같은 데이터 형식을 가지게 된다. [Statement](https://github.com/in-toto/attestation/tree/main/spec/v0.1.0#statement)의 규격과 [Predicate](https://github.com/in-toto/attestation/tree/main/spec/v0.1.0#predicate) 규격을 함께 확인할 수 있다. 예를 들어서 소스코드로부터 Container Image가 생성되고 Container Registry에 Push되는 Tekton Pipeline이 있다면, `subject`는 최종 산출물인 container image가 저장된 container registry URL과 해당 image의 digest 값이 정의 된다. `Predicate`는 [SLSA Provenance 형식](https://slsa.dev/spec/v1.0-rc1/provenance)으로 Container Image가 최종 생성되기까지의 각 단계에 대한 정보들을 담게 된다.

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "subject": [
    {
      "name": "{container image의 경우에 container registry URL}",
      "digest": { "sha256": "{image digest 값}" }
    }
  ],
  "predicate": {}
}
```

이렇게 규격에 따라서 최종 소프트웨어 산출물이 어떤 단계로 만들어지게 되었는지 메타데이터를 남기고, 그것을 최종 산출물과 같이 보관하여 확인할 수 있게 된다.

## SLSA

위에서 Predicate type으로 `SLSA Provenance`가 사용되었다. SLSA는 `The Supply Chain Levels for Software Artifacts`의 약자로 SLSA Framework는 Supply chain security에 대한 checklist를 제공한다. SLSA Framework는 Level을 나누어서 각 Level에 해당하는 가이드라인을 제공한다. Level1부터 Level4까지 정의되어 있는데, Level이 높을 수록 Supply chain에 대한 더 높은 신뢰를 제공할 수 있는 구성이라고 판단할 수 있다. 그런데 [Tekton Chain을 사용할 경우에 기본적으로 SLSA Level 2에 대한 가이드라인을 준수](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)하여 파이프라인을 구성할 수 있다. 이렇게 SLSA framework의 가이드라인에 따라서 구성되기 때문에 Predicate가 SLSA Provenance 형식으로 남게 되는 것이다.

## Sigstore

[Tekton 문서에 Tekton Chain을 통해서 전자서명된 출처 정보를 남기는 예제](https://tekton.dev/docs/chains/signed-provenance-tutorial/)가 잘 설명되어 있다. 해당 문서에 구조도 이미지가 아래처럼 있다. 그림에서 `Cosign`과 `Rekor`가 보인다.

<img src="/static/images/supply-chain-security-tekton-example.png" alt="tekton chain example" />

`Cosign`과 `Rekor`는 [Sigstore Project](https://www.sigstore.dev/how-it-works)에 속해있는데, `Cosign`은 다양한 Artifact들을 Sign하고 Verify할 수 있는 툴을 제공한다. Rekor는 원장으로 변경될 수 없도록 Log entry를 저장할 수 있도록 해준다. Tekon Chain을 구성할 때, `Cosign`을 통해서 만들어진 Container Image를 Sign하고 Signature를 OCI Registry에 저장할 수 있다. 또 Tekon Chain에서 생성된 Attestation 데이터를 Sign하고 동일하게 Signature와 함께 OCI Registry에 저장할 수 있다. 그리고 `Cosign`을 통해서 Image signature, attestation signature를 verify할 수 있다. Rekor에는 Attestation 정보를 저장할 수 있는데, 블록체인 기반으로 나중에 변경할 수 없도록 저장하게 되고 원장에서 ID로 검색하여 출처 정보들을 확인할 수 있다.

### Cosign sign / verify

Cosign으로 Container image를 sign하고 verify해보자. 먼저 cosign를 설치한다.

```bash
brew install cosign
```

openssl과 비교해보기 위해서 openssl으로 Private key를 생성한다. [Cosign Signature SPEC 문서](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md#signature-schemes)를 확인하면 ECDSA-P256를 지원해야한다고 나와서 아래와 같이 생성했다. Elliptic Curve Digital Signature Algorithm(ECDSA)는 Elliptic Curve Cryptography(ECC)로 만들어진 key로 Signature를 만드는 것을 말한다.

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private.key
```

openssl된 private key를 cosign으로 import할 수 있는 명령어가 있어서 아래와 같이 실행한다. cosign에서 private key는 암호를 설정해서 key를 암호화한다. 정상적으로 실행되면 `import-cosign.key`와 `import-cosign.pub` 파일이 생성된다.

```bash
$ cosign import-key-pair -key private.key
WARNING: the -key flag is deprecated and will be removed in a future release. Please use the --key flag instead.
Enter password for private key:
Enter password for private key again:
Private key written to import-cosign.key
Public key written to import-cosign.pub
```

이제 생성된 key pair로 아래와 같이 sign을 하고 verify할 수 있다. `tlog-upload=false`는 Rekor에 log entry를 upload하지 않도록 하기 위해서 설정했고, `upload=false`는 OCI registry에 signature을 올리지 않도록 설정하였다. 대신에 `output-signature`와 `output-payload`를 통해서 해당 값을 Local에 저장하도록 하였다. `upload=true`로 하면 OCI registry에 해당 데이터를 올리게 된다.

```bash
cosign sign \
--key import-cosign.key \
--tlog-upload=false \
--upload=false \
--output-signature=signature.dat \
--output-payload=payload.dat \
registry.hub.docker.com/library/busybox@sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414
```

```bash
cosign verify \
--key import-cosign.pub \
--insecure-ignore-tlog=true \
--signature=signature.dat \
--payload=payload.dat \
registry.hub.docker.com/library/busybox@sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414
```

payload.dat를 보면, [Cosign Signature SPEC 문서에 나온 것처럼](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md#payloads) 되어 있는 것을 확인할 수 있다.

```bash
$ cat payload.dat| jq .
{
  "critical": {
    "identity": {
      "docker-reference": "registry.hub.docker.com/library/busybox"
    },
    "image": {
      "docker-manifest-digest": "sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414"
    },
    "type": "cosign container image signature"
  },
  "optional": null
}
```

`crane`을 사용해서 DockerHub public image `busybox`의 manifest를 저장한다.

```bash
crane manifest registry.hub.docker.com/library/busybox@sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414 > manifest.json
```

그리고 sha256 digest를 생성하면, 위의 payload에서 `docker-manifest-digest` 값과 동일한 것을 확인할 수 있다.

```bash
$ sha256sum manifest.json
538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414  manifest.json
```

openssl을 통해서 이 payload를 private key로 sign 해본다.

```bash
openssl dgst -sha256 -sign private.key -out sig.openssl payload.dat
```

openssl로 생성된 signature로 cosign verify를 해도 이제 정상적으로 verify가 된다. `insecure-ignore-tlog`는 rekor에서 log entry를 가져와서 검증하는 단계를 생략하는 설정이다.

```bash
cosign verify \
--key import-cosign.pub \
--insecure-ignore-tlog=true \
--signature=sig.openssl \
--payload=payload.dat \
registry.hub.docker.com/library/busybox@sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414
```

```bash
WARNING: Skipping tlog verification is an insecure practice that lacks of transparency and auditability verification for the signature.

Verification for registry.hub.docker.com/library/busybox@sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key

[{"critical":{"identity":{"docker-reference":"registry.hub.docker.com/library/busybox"},"image":{"docker-manifest-digest":"sha256:538721340ded10875f4710cad688c70e5d0ecb4dcd5e7d0c161f301f36f79414"},"type":"cosign container image signature"},"optional":null}]
```

이제 네이버 클라우드 Container Registry에 cosign을 통해서 signature를 upload해본다.

```bash
docker login -u {username} {private image registry url}
```

```bash
cosign sign \
--key import-cosign.key \
--tlog-upload=false \
-a timestamp=1707360932 \
--upload=true \
examle.ncr.gov-ntruss.com/sample@sha256:9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc
```

`triangulate` 명령어로 signature가 OCI registry에 어떤 tag로 저장이 되었는지 확인할 수 있다. `image digest`에 `.sig`가 붙은 tag가 생성된다.

```bash
$ cosign triangulate example.ncr.gov-ntruss.com/sample@sha256:9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc
example.ncr.gov-ntruss.com/sample:sha256-9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc.sig
```

이제 signature을 image로부터 받아오면 [Cosign Signature SPEC](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md#payloads)형식에 맞춰서 데이터가 저장되어 있는 것을 확인할 수 있다.

```bash
$ cosign download signature example.ncr.gov-ntruss.com/sample@sha256:9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc
{
  "Base64Signature": "{sig값}",
  "Payload": "{payload값}"
  "Cert": null,
  "Chain": null,
  "Bundle": null,
  "RFC3161Timestamp": null
}
```

이제 정상적으로 verify할 수 있다.

```bash
cosign verify \
--key import-cosign.pub \
--insecure-ignore-tlog=true \
examle.ncr.gov-ntruss.com/sample@sha256:9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc
```

### Attestation

Tekon Pipeline으로 Bitbucket에 Source Code를 Clone하고, Dockerfile으로 image를 build하고 Container Registry에 push했다고 하자. 그러면 Tekton Chain을 통해서 아래와 같이 Attestation 정보가 생성된다.

`sample.json`

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "subject": [
    {
      "name": "example.ncr.gov-ntruss.com/sample",
      "digest": { "sha256": "9a0d19a51878b834282d2acf806f05053a801d79fc1de166973465731cd4b5bc" }
    }
  ],
  "predicate": {
    "builder": { "id": "https://tekton.dev/chains/v2" },
    "buildType": "tekton.dev/v1beta1/TaskRun",
    "invocation": {
      "configSource": {},
      "parameters": {
        "BUILDER_IMAGE": "gcr.io/kaniko-project/executor:v1.20.0-debug",
        "CHAINS-GIT_COMMIT": "aaf7c80a512c1d7ee146f8462af19596497c4616",
        "CHAINS-GIT_URL": "git@bitbucket.org:example/sample.git",
        "CONTEXT": "./",
        "DOCKERFILE": "./Dockerfile",
        "EXTRA_ARGS": [],
        "IMAGE": "example.ncr.gov-ntruss.com/sample"
      },
      "environment": {
        "annotations": {
          "pipeline.tekton.dev/affinity-assistant": "affinity-assistant-fdbbf5ed3d",
          "pipeline.tekton.dev/release": "e1c7828",
          "tekton.dev/categories": "Image Build",
          "tekton.dev/displayName": "Build and upload container image using Kaniko",
          "tekton.dev/pipelines.minVersion": "0.17.0",
          "tekton.dev/platforms": "linux/amd64,linux/arm64,linux/ppc64le",
          "tekton.dev/tags": "image-build"
        },
        "labels": {
          "app.kubernetes.io/managed-by": "tekton-pipelines",
          "app.kubernetes.io/version": "0.6",
          "hub.tekton.dev/catalog": "tekton",
          "tekton.dev/memberOf": "tasks",
          "tekton.dev/pipeline": "clone-build-push",
          "tekton.dev/pipelineRun": "clone-build-push-run-pp4vp",
          "tekton.dev/pipelineTask": "build-push",
          "tekton.dev/task": "kaniko"
        }
      }
    },
    "buildConfig": {
      "steps": [
        {
          "entryPoint": "",
          "arguments": [
            "--dockerfile=./Dockerfile",
            "--context=/workspace/source/./",
            "--destination=example.ncr.gov-ntruss.com/sample",
            "--digest-file=/tekton/results/IMAGE_DIGEST"
          ],
          "environment": {
            "container": "build-and-push",
            "image": "oci://gcr.io/kaniko-project/executor@sha256:6976d731d1fc2a4e89986d833c1538946bd36b43e21fb1d0db38fe9499adc49c"
          },
          "annotations": null
        },
        {
          "entryPoint": "set -e\nimage=\"example.ncr.gov-ntruss.com/sample\"\necho -n \"${image}\" | tee \"/tekton/results/IMAGE_URL\"\n",
          "arguments": null,
          "environment": {
            "container": "write-url",
            "image": "oci://docker.io/library/bash@sha256:c523c636b722339f41b6a431b44588ab2f762c5de5ec3bd7964420ff982fb1d9"
          },
          "annotations": null
        }
      ]
    },
    "metadata": {
      "buildStartedOn": "2024-02-09T09:14:02Z",
      "buildFinishedOn": "2024-02-09T09:18:07Z",
      "completeness": { "parameters": false, "environment": false, "materials": false },
      "reproducible": false
    },
    "materials": [
      {
        "uri": "oci://gcr.io/kaniko-project/executor",
        "digest": { "sha256": "6976d731d1fc2a4e89986d833c1538946bd36b43e21fb1d0db38fe9499adc49c" }
      },
      {
        "uri": "oci://docker.io/library/bash",
        "digest": { "sha256": "c523c636b722339f41b6a431b44588ab2f762c5de5ec3bd7964420ff982fb1d9" }
      },
      {
        "uri": "git@bitbucket.org:example/sample.git",
        "digest": { "sha1": "aaf7c80a512c1d7ee146f8462af19596497c4616" }
      }
    ]
  }
}
```

container image를 cosign으로 sign해서 OCI registry에 올린 것처럼, attestation 파일도 cosign으로 sign해서 OCI resgistry에 올릴 수 있다. 아래와 같이 `attest` 명령어를 사용하면 `image digest`에 `.attr`가 붙어서 OCI registry에 저장된다.

```bash
cosign attest --key import-cosign.key --predicate sample.json example.ncr.gov-ntruss.com/sample
```

`download attestation` 명령어로 데이터를 보면 위에서 우리가 `In-toto` Envelope 규격에 맞춰서 들어가 있는 것을 확인할 수 있다.

```bash
cosign download attestation example.ncr.gov-ntruss.com/sample | jq .
```

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "payload 값",
  "signatures": [
    {
      "keyid": "",
      "sig": "sig 값"
    }
  ]
}
```

signature를 verify하는 것처럼 attestation도 private key로 sign되어 있기 때문에, public key로 verify를 하게 된다.

```bash
cosign verify-attestation \
-d \
--insecure-ignore-tlog \
--key import-cosign.pub  \
example.ncr.gov-ntruss.com/sample
```

## Tekton Chain

이제 Tekton Chain을 [Tekton 문서의 예제](https://tekton.dev/docs/chains/signed-provenance-tutorial/)를 참고하여 설정해본다.

Tekton peipline은 아래와 같은 작업을 할 수 있도록 구성한다.

- Bitbucket에서 Source code를 가져옴
- source code에 정의된 Dockerfile로 Container image를 빌드함
- 해당 Container image를 container registry에 Push함

### Secret 설정

Bitbucket private registry의 경우에는 Kubernetes secret에 read only ssh key를 저장한다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: git-credentials
data:
  id_rsa: AS0tLS...
  known_hosts: AG033S...
```

`known_hosts` 값은 [bitbucket 문서](https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/)에 따라서 아래처럼 요청해서 가지고온 값으로 설정해준다.

```bash
curl https://bitbucket.org/site/ssh | base64
```

그리고 Docker image를 push할 수 있도록 Secret을 생성해준다. `Kaniko`라는 tekton task를 사용할 때, Secret은 `config.json`으로 저장해야 한다. `주의해야 할 점`은 `아래처럼 생성하면 .dockerconfigjson으로 데이터가 저장된다.`

```bash
create secret docker-registry docker-credentials \
--docker-server={registry url} \
--docker-username={username}
--docker-password={password}
```

아래와 같이 `config.json`으로 저장되어야지 `Kaniko`에서 정상적으로 해당 credentials로 Docker private registry에 push할 수 있다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: docker-credentials
data:
  config.json: { base64 데이터 }
```

### Tekton Pipeline 셋팅

먼저 `tkn` 명령어를 사용하기 위해서 cli를 설치한다.

```bash
brew install tektoncd-cli
```

tekon pipeline을 설치하고,

```bash
kubectl apply -f \
https://storage.googleapis.com/tekton-releases/pipeline/previous/v0.56.0/release.yaml
```

tekton hub을 통해서 필요한 task를 설치한다.

```bash
tkn hub install task git-clone
tkn hub install task kaniko
```

아래처럼 yaml 파일로 저장하여 배포할 수도 있다.

```bash
tkn hub get task git-clone --version 0.9 > tkn-git-clone.yaml
```

tekton chain을 설치한다.

```bash
kubectl apply -f \
https://storage.googleapis.com/tekton-releases/chains/previous/v0.20.0/release.yaml
```

Tekton Chain으로 SLSA attestation version 0.2 규격을 맞춰서 생성하도록 `slsa/v1`으로 지정해줬고, OCI registry에 저장할 수 있도록 stroage를 oci로 지정하였다. cosign에 생성된 signature가 위에서 본것처럼 `{image digest}.sig` tag로 registry에 push되고, attestation도 `{image digest}.att` tag로 registry에 push된다.

```bash
kubectl patch configmap chains-config -n tekton-chains -p='{"data":{"artifacts.taskrun.format": "slsa/v1"}}'
kubectl patch configmap chains-config -n tekton-chains -p='{"data":{"artifacts.taskrun.storage": "oci"}}'
kubectl patch configmap chains-config -n tekton-chains -p='{"data":{"artifacts.oci.storage": "oci"}}'
```

cosign에서는 key 생성을 Kubernetes secret에 저장할 수 있는 명령어를 아래처럼 제공한다. 이렇게 생성하면 tekton-chains namespace에 signing-secrets이라는 이름으로 cosign.pub, consign.key, cosign.password 값으로 저장된다.

```bash
cosign generate-key-pair k8s://tekton-chains/signing-secrets
```

Tekton pipeline을 아래와 같이 정의하고 쿠버네티스에 생성한다.

```tekton-pipeline.yaml`

```yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: clone-build-push
spec:
  description: |
    This pipeline clones a git repo, builds a Docker image with Kaniko and
    pushes it to a registry
  params:
    - name: repo-url
      type: string
    - name: image-reference
      type: string
  workspaces:
    - name: shared-data
    - name: docker-credentials
    - name: git-credentials
  tasks:
    - name: fetch-source
      taskRef:
        name: git-clone
      workspaces:
        - name: output
          workspace: shared-data
        - name: ssh-directory
          workspace: git-credentials
      params:
        - name: url
          value: $(params.repo-url)
    - name: build-push
      runAfter: ['fetch-source']
      taskRef:
        name: kaniko
      workspaces:
        - name: source
          workspace: shared-data
        - name: dockerconfig
          workspace: docker-credentials
      params:
        - name: IMAGE
          value: $(params.image-reference)
        - name: BUILDER_IMAGE
          value: gcr.io/kaniko-project/executor:v1.20.0-debug
        - name: CHAINS-GIT_COMMIT
          value: '$(tasks.fetch-source.results.commit)'
        - name: CHAINS-GIT_URL
          value: '$(tasks.fetch-source.results.url)'
```

Attestation에 Build할 때 사용한 source code의 git commit과 url을 같이 남기고 싶어서 [Tekton 문서](https://tekton.dev/docs/chains/slsa-provenance/#git-results)을 참고하여 params에 아래와 같이 추가를 해주었다.

```yaml
- name: CHAINS-GIT_COMMIT
  value: '$(tasks.fetch-source.results.commit)'
- name: CHAINS-GIT_URL
  value: '$(tasks.fetch-source.results.url)'
```

이제 PipelineRun을 아래와 같이 정의하고, 생성하면 Pipeline이 실행된다.

`tekton-pipeline-run.yaml`

```yaml
apiVersion: tekton.dev/v1beta1
kind: PipelineRun
metadata:
  generateName: clone-build-push-run-
spec:
  serviceAccountName: tekton-sa
  pipelineRef:
    name: clone-build-push
  podTemplate:
    securityContext:
      fsGroup: 65532
  workspaces:
    - name: shared-data
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
    - name: docker-credentials
      secret:
        secretName: docker-credentials
    - name: git-credentials
      secret:
        secretName: git-credentials
  params:
    - name: repo-url
      value: { bitbucket repository url 값 }
    - name: image-reference
      value: example.ncr.gov-ntruss.com/sample
```

```bash
kubectl create -f tekton-pipeline-run.yaml
```

이제 정상적으로 모든 Tekton Task가 동작하고 나면, build된 Container Image와 함께 `.sig`, `.att`의 데이터가 OCI registry에 같이 올라가게 된다. 이제 cosign으로 signature와 attestation을 verify할 수 있다.

```bash
cosign verify \
--key k8s://tekton-chains/signing-secrets \
--insecure-ignore-tlog=true \
example.ncr.gov-ntruss.com/sample
```

```bash
cosign verify-attestation \
--key k8s://tekton-chains/signing-secrets \
--type slsaprovenance \
--insecure-ignore-tlog=true \
example.ncr.gov-ntruss.com/sample
```

## NPM

[npm에서도 in-toto Spec에 따라서 Provenance를 같이 배포할 수 있도록 지원한다고 작년 4월에 블로그를 통해서 소개하였다.](https://github.blog/2023-04-19-introducing-npm-package-provenance/) 예를 들어서 [@sigstore/cli](https://www.npmjs.com/package/@sigstore/cli/v/0.6.0) 패키지의 경우에는 아래와 같이 Github Action으로 Provenance를 같이 배포하여 정보가 나와있다.

<img src="/static/images/supply-chain-security-npm.png" alt="provenance in npm" />

`Transparency log entry`를 누르면, 이러한 metadata들이 변경되지 않게 보관할 수 있는 rekor server에 저장된 entry를 확인할 수 있다.

<img src="/static/images/supply-chain-security-rekor.png" alt="log entry in rekor" />

아래와 같은 명령어로 signature를 확인하는데, Rekor log entry에서 이 signature가 변경되지 않았는지 확인하는 과정을 가진다. `npm install`할 때도 동일하게 npm registry에서 signature를 verify하고 download하게 된다.

```bash
npm audit signatures
```

## rekor로 tekon pipeline image 확인

[Tekton Pipeline release 페이지](https://github.com/tektoncd/pipeline/releases)에서 container image들을 rekor로 verify하는 과정을 설명하고 있다.

먼저 Go를 통해서 reckor-cli를 설치한다. binary 파일은 아래와 같이 GOPATH 경로에서 확인할 수 있다.

```bash
go install -v github.com/sigstore/rekor/cmd/rekor-cli@latest
```

```bash
$ go env GOPATH
/Users/jayground8/go
```

```bash
export PATH=$PATH:/Users/jayground8/go/bin
```

Rekor 서버에서 서명된 메타데이터를 올리면 UUID를 생성된다. 해당 UUID로 저장된 데이터를 가져올 수 있다. 그런데 rekor-cli 문서를 보면 UUID entry가 merkle tree hash라고 설명이 있다. Rekor에 대한 설명에서 `Ledger`라고 나와있었는데, 데이터 조작이 될 수 없도록 블록체인 방식으로 저장이 되어 있고 그래서 merkel tree hash 값을 사용하고 있는 것 같다. 이제 아래와 같이 UUID로 entry log를 가져오면 container image의 sha256 digest을 확인할 수 있다.

```bash
REKOR_UUID=24296fb24b8ad77a0c94b8ccf25fa815c6b01ab90941b17a37373885d8f62efc99b17eea417bed4d
REKOR_ATTESTATION_IMAGES=$(rekor-cli get --uuid "$REKOR_UUID" --format json | jq -r .Attestation | jq -r '.subject[]|.name + ":v0.56.0@sha256:" + .digest.sha256')
```

```bash
$ echo $REKOR_ATTESTATION_IMAGES
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/controller:v0.56.0@sha256:fc5669e1bbabbf24b0ee4591ff20793643d778942e91ae52b3f7cca26d81a99b
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/entrypoint:v0.56.0@sha256:381ca58f0f911b6954530ea820bdda12850e535db9c6a85a17a02e3dd49345fb
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/nop:v0.56.0@sha256:4e627be53f78f30f73084ea0695d97397930d6f12d4cfab28d97b1aa57842881
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/sidecarlogresults:v0.56.0@sha256:4db16701d6e54d80cbb7b51e021d3f5698196d08d2f1ff33728154807ef1fe86
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/workingdirinit:v0.56.0@sha256:c488368eff45a745dd58e65f526d746abcad431796bb0e719ecf2d5f71491692
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/events:v0.56.0@sha256:c7fe97153fc32ea3eae343bcaf96761c9b0d80c8098ee35922550f0caf6887e0
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/resolvers:v0.56.0@sha256:8c0598a04420caa0ee3aeb6fef7521f93f4c41f7308ccb0c616167dc1d5fa00a
gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/webhook:v0.56.0@sha256:99824836bb47c1d9e21efdeff56e02b9426fe2323a22625b7af4f66a4028a5b4
```

최종적으로 아래와 같이 Rekor에서 가져온 Entry log의 sha256 digest 값을 release.yaml에서 정의된 container image들의 sha256 digest값과 비교해서 일치하는지 확인한다.

```bash
RELEASE_FILE=https://storage.googleapis.com/tekton-releases/pipeline/previous/v0.56.0/release.yaml
REKOR_UUID=24296fb24b8ad77a0c94b8ccf25fa815c6b01ab90941b17a37373885d8f62efc99b17eea417bed4d

# Obtains the list of images with sha from the attestation
REKOR_ATTESTATION_IMAGES=$(rekor-cli get --uuid "$REKOR_UUID" --format json | jq -r .Attestation | jq -r '.subject[]|.name + ":v0.56.0@sha256:" + .digest.sha256')

# Download the release file
curl "$RELEASE_FILE" > release.yaml

# For each image in the attestation, match it to the release file
for image in $REKOR_ATTESTATION_IMAGES; do
  printf $image; grep -q $image release.yaml && echo " ===> ok" || echo " ===> no match";
done
```

이렇게 container image들을 verify하고 tekon pipelie 설치를 진행한다.

```bash
kubectl apply -f \
https://storage.googleapis.com/tekton-releases/pipeline/previous/v0.56.0/release.yaml
```

## cosign verify distroless

[Google에서 관리하는 Distoless Container Image](https://github.com/GoogleContainerTools/distroless)를 보면 consign으로 서명을 확인한다. Sigstore에서는 keyless 방식으로 sign하고 verify하는 것을 추천한다. keyless mode를 이해하는 것도 재미있는 주제인데, 다음에 블로그로 정리해볼려고 한다. 아래와 같이 public key 대신에 identity로 verify를 할 수가 있다.

```bash
cosign verify $IMAGE_NAME --certificate-oidc-issuer https://accounts.google.com  --certificate-identity keyless@distroless.iam.gserviceaccount.com
```

## 결론

Kubernetes cluster를 운영할 때, Tekon Chain을 통해서 Software Supply Chain Security를 고려할 수 있다. Tekton Chain을 통해서 Container Image와 In-toto Attestation을 sign하고, OCI Registry에 push를 했다. 해당 데이터들이 OCI Registry에 `{image digest}.sig`와 `{image digest}.att` tag로 push 된다. 이렇게 Cosign으로 sign해서 저장했기 때문에, 해당 파일을 signature와 public key로 verify할 수 있다. 추가로 Rekor에 log entry가 등록되어 있으면, 변경될 수 있는 log 데이터를 통해서 signature를 추가 검증할 수 있다. 또한 GateKeeper로 Policy를 추가하여 올바르게 sign된 container image만 Kubernetes cluster에 적용할 수 있도록 구성할 수 있다. Attestation도 동일하게 sign하고 verify할 수 있는데, cosign으로 verify하는 것은 Provenance에 있는 정보들을 verify하는 것은 아니다. 따라서 Attestation으로 Software Supply Chain Security를 강화하기 위해서는 Attestation에 저장되어 있는 정보를 verify하는 로직을 추가해야 한다.
