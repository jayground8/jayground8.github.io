---
title: 'secrets-store-csi-driver-provider-gcp 사용해보기'
date: '2025-01-05'
tags: ['gcp', 'kubernetes']
images: ['/static/images/social-banner.png']
summary: 'GKE에서 add-on 기능으로 관리형 서비스인 Google Secret Manager을 Kubernetes Secrets Store CSI Driver로 쉽게 사용할 수 있다. 하지만 add-on 버전에서는 Sync as Kubernetes Secret 기능을 제공하지 않기 때문에, Kubernetes Secret을 환경변수로 설정하는데 제약사항이 있다. 직접 Kubernetes Secrets Store CSI driver와 GCP provider driver를 설치하여 Sync as Kubernetes Secret 기능을 사용할 수 있다. 이렇게 Sync된 Kubernetes Secret을 환경변수로 주입하도록 설정할 수 있다. Google Secret Manager는 아쉽게도 하나의 Secret에 복수의 key value를 제공하지 않는다. 이번 글에서는 Google Secret Manager를 Kubernetes Secret Object와 Sync해서 사용하는 것이 바람직할지 고민해본다.'
---

GKE(Google Kubernetes Engine)을 사용하는 경우에 Container에 비밀값을 환경변수로 어떻게 주입할 수 있을까?

## GKE Add-on

Public Cloud Provider를 이용할 때, 운영에 대한 부담을 줄일 수 있는 managed service를 확인하게 된다. GCP에는 Secret Manager Service가 있고, GKE에서 add-on으로 간단하게 설정할 수 있다. 아래처럼 GKE Cluster에서 Secret Manager를 Enable하면 Kubernetes Secrets Store CSI Driver처럼 사용할 수 있다.

<img src="/static/images/gke-secret-manager-add-on.png" alt="gke add-on option for secret manager" />

하지만 [공식 문서](https://cloud.google.com/secret-manager/docs/secret-manager-managed-csi-component#limitations)에 나온 것처럼, 비밀값이 변경되었을 때 반영해주는 Secret auto rotation 기능과 Kubernetes Secret Object를 생성하여 Sync을 맞추는 기능은 제공하지 않는 제약사항이 있다. 따라서 아래처럼 Secret Object을 통해서 환경변수를 Container에 주입하는 경우에는 해당 Add-on 옵션을 사용할 수 없다.

```yaml
envFrom:
  - secretRef:
      name: app-secrets
```

## secrets-store-csi-driver 직접 설치

[secrets-store-csi-driver](https://github.com/kubernetes-sigs/secrets-store-csi-driver)를 직접 설치하여 해당 기능들을 사용하는 방법이 있다. 이 글을 작성하는 시점에는 `syncSecret`과 `enableSecretRotation` 기능은 Alpha 기능으로 제공되고 있어서 아래와 같이 ArgoCD Helm으로 배포할 경우에 values에 사용하도록 설정을 해줘야 한다.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: secrets-store-csi-driver
  namespace: argocd
spec:
  project: default
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
  destination:
    server: 'https://kubernetes.default.svc'
    namespace: kube-system
  source:
    chart: secrets-store-csi-driver
    repoURL: https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
    targetRevision: 1.4.7
    helm:
      releaseName: secrets-store-csi-driver
      values: |
        syncSecret:
          enabled: true
        enableSecretRotation: true
```

Google Secret Manager를 Secrets Store CSI driver에서 사용할 수 있도록 GCP용 provider를 설치한다. 아직 해당 Helm Chart는 public하게 publish하지 않아서 [secrets-store-csi-driver-provider-gcp](https://github.com/GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp) Github Repo를 Clone하여 아래와 같이 Helm으로 설치할 수 있다.

```bash
helm upgrade \
--install secrets-store-csi-driver-provider-gcp \
charts/secrets-store-csi-driver-provider-gcp
```

## Test

`gcloud cli`를 통해서 예제 Secret 값을 생성한다.

```bash
echo "helloworld" > secret.data
gcloud secrets create testsecret \
--replication-policy=automatic \
--data-file=secret.data
```

그리고 해당 Secret에 접근 권한을 준 service account를 생성한다.

```bash
gcloud iam service-accounts tutorial-workload

gcloud iam service-accounts add-iam-policy-binding \
--role roles/iam.workloadIdentityUser \
--member "serviceAccount:tutorial-prj.svc.id.goog[default/example]" \
tutorial-workload@tutorial-prj.iam.gserviceaccount.com

gcloud secrets add-iam-policy-binding testsecret \
--member=serviceAccount:tutorial-workload@tutorial-prj.iam.gserviceaccount.com \
--role=roles/secretmanager.secretAccessor
```

Secrets Store CSI Driver가 설치되었기 때문에 아래와 같이 `SecretProviderClass` Ojbect를 생성한다. 그리고 secrets-store-csi-driver-provider-gcp가 설치되었기 때문에 spec.provider가 gcp로 설정할 수가 있다.

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: app-secrets
spec:
  provider: gcp
  parameters:
    secrets: |
      - resourceName: "projects/tutorial-prj/secrets/testsecret/versions/latest"
        fileName: "secret.data"
  secretObjects:
    - secretName: app-secrets
      type: Opaque
      data:
        - objectName: secret.data
          key: example
```

Pod에서 Secret에 접근할 수 있도록 Kubernetes에 Service Account를 아래와 같이 생성한다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: example
  namespace: default
  annotations:
    iam.gke.io/gcp-service-account: tutorial-workload@tutorial-prj.iam.gserviceaccount.com
```

마지막으로 Secret을 driver를 통해서 VolumeMount를 하고, Sync as Kubernetes Secret 기능으로 생성된 Secret Object으로 환경변수를 주입하도록 한다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: mypod
  namespace: default
spec:
  serviceAccountName: example
  containers:
    - image: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
      imagePullPolicy: IfNotPresent
      name: mypod
      envFrom:
        - secretRef:
            name: app-secrets
      volumeMounts:
        - mountPath: '/var/secrets'
          name: mysecret
          readOnly: true
  volumes:
    - name: mysecret
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes:
          secretProviderClass: 'app-secrets'
```

정상적으로 설정이 되었다면 app-secrets Kubernetes Secret Object가 생성되고, Container에 정상적으로 환경변수로 주입되게 된다.

## 한계

오픈소스로 직접 운영할 수 있는 Hashicorp Vault와 비교할 때, GCP Secret Manager는 Secret 하나에 복수의 key value로 저장할 수 없다는 것이 아쉽다. Vault를 사용할 때 [Vault Secrets Operator](https://developer.hashicorp.com/vault/docs/platform/k8s/vso)를 통해서 Vault의 Secret을 Kubernetes의 Secret Object와 Sync를 할 수 있다. 아래처럼 Vault Secret은 하나의 Secret에 복수의 key value로 설정할 수 있기 때문에, Container에게 필요한 모든 비밀값을 하나의 Secret으로 묶어서 관리할 수 있다.

<img src="/static/images/gke-vault-create-secret.png" alt="create new secret on vault ui" />

GCP Secret Manager의 Secret에는 하나의 key value만 설정할 수 있다. 복수의 key value로 구성된 JSON같은 파일로 저장해서 Secret에 저장할 수 있지만, 그것을 하나의 Kubernetes Secret으로 Sync하는 방법이 제공되지 않는다.

<img src="/static/images/gke-google-create-secret.png" alt="create new secret on gcp console" />

GCP Secret Manager에서 한쌍의 Key Value로만 관리한다면, Label을 통해서 Secret을 Group으로 묶는 방법을 고려할 수 있다. 그리고 SecretProviderClass에서 복수의 Secret들을 하나의 Kubernetes Secret Object로 묶어주는 작업을 해줘야 한다.

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: app-secrets
spec:
  provider: gcp
  parameters:
    secrets: |
      - resourceName: "projects/tutorial-prj/secrets/soemthing/versions/latest"
        fileName: "something"
      - resourceName: "projects/tutorial-prj/secrets/else/versions/latest"
        fileName: "else"
  secretObjects:
    - secretName: app-secrets
      type: Opaque
      data:
        - objectName: something
          key: SOMETHING
        - objectName: else
          key: ELSE
```

또한 Secret의 key이름이 고유해야 하기 때문에, 환경별로 어플리케이션이 Secret을 지정하려면 명명 규칙이 필요하다.

## 비용

Secret 버전당 $0.06와 엑세스 작업 10,000번당 $0.03의 비용이 청구된다. Secret Auto Rotation을 위해서 Pub/Sub으로 Topic을 발행하면 추가로 알림당 $0.05의 비용이 발생한다. 이번 계산에서는 알림에 의한 비용은 무시한다.

그러면 Secret의 버전을 최신 하나만 유지한다고 했을 때, Secret 갯수 \* $0.06 금액이 발생한다. Secret이 100개라고 하면 6달러 금액이 발생할 수 있다. 그리고 액새스 작업은 Secret Auto Rotation 기능의 활성화로 Polling하는 주기에 따라서 요금이 측정될 수 있다. Secrets Store CSI Driver에서 해당 기능의 기본 polling 주기는 2분으로 설정되어 있기 때문에, 하나 Secret당 Polling에 따라서 발생하는 금액은 월 0.12달러 정도가 된다. 이것도 Secret이 100개라고 하면 12달러 정도 금액이 발생한다.

100~200개의 Secret을 관리하는 것은 Vault를 HA Mode로 3개 Node를 CPU resource request 1로 운영하면서 발생하는 VM 비용보다 상당이 유리하다.

## 결론

GKE에서 Secret Manager를 사용하여 Application에 비밀값을 주입한다면 아래와 같은 우선순위로 고려해볼 수 있겠다.

1. Google Secret Manager API로 직접 비밀값을 바로 가져와서 사용
   - 보안적으로 가장 유리
   - Secret Manager에 장애가 있을 때 바로 영향을 받음. Google Secret Manager는 99.95% Uptime SLA를 제공하기 때문에, 한달에 약 22분 이상은 downtime이 발생하지 않도록 하고 있다.
2. `.env` 파일과 같이 파일 형식으로 불러와서 사용
   - Secrets Store CSI Driver로 Volume Mount된 파일을 그대로 사용할 수 있다.
   - Vault UI를 통해서 Secret의 key-pair를 N개 관리하는 것과 비교하면 불편하다. 관리해야 되는 Secret이 많다면, Secrets Store CSI Driver를 사용하더라도 Vault provider를 사용하는 것이 더 바람직하다고 판단된다.
3. Kubernetes Secret Object로 주입할 때는 Secret 갯수가 적고 변경이 적다면 [External Secrets Operator](https://external-secrets.io/latest/provider/google-secrets-manager/)나 Secrets Store CIS Driver를 사용하고, Secret 갯수가 많고 변경이 잦으면 Vault를 사용
   - Secret 갯수가 많아지면 Secret Manager를 사용하는 비용도 올라가고, 그것들을 관리하는 것도 어려워진다.
   - Vault UI Console에서 Vault Role을 통해서 개발자에게 권한을 위임하는 것이 편리하다. 비밀값의 변경이 잦고 개발자에게 관리를 위임해야 한다면 Vault가 유리하다.

Kubernetes에서 Application에 환경변수로 비밀값을 주입해야되는 제약사항이 있다라고 하면, Application이 여러 개가 존재하고 다양한 비밀값이 관리된다고 하면 Vault를 직접 운영하여 사용하는 것이 바람직하다고 판단된다. 아주 간단하게만 사용될 때만 Secrets Store CSI driver를 사용하는 것이 좋겠다.
