---
title: 'Bitbucket OIDC with GCP'
date: '2025-01-17'
tags: ['gcp', 'oidc', 'bitbucket']
images: ['/static/images/social-banner.png']
summary: 'Bitbucket OIDC를 이용하여 GCP 리소스를 접근하는 방법을 설명한다. Bitbucket Pipeline으로 GCP 리소스를 배포/변경할 때 OIDC를 통해서 임시 Credential를 발급할 수 있다. 다른 사람이 동일한 작업을 할 때, 삽질하지 않도록 완전한 예제를 공유하고자 작성한다.'
---

이번에는 Bitbucket Pipeline를 이용할 때 OIDC를 통해서 GCP Resource에 접근하는 방법을 설명한다. [Bitbucket OIDC를 통해서 GCP에 접근하는 예제](https://github.com/GoogleCloudPlatform/gcp-bitbucket-wif)를 참고하여 설정을 완료할 수 있었다.

## workload identity pool 생성

> A workload identity pool is an entity that lets you manage external identities.

```bash
gcloud iam workload-identity-pools create bitbucket-pool \
--location="global" \
--display-name="bitbucket-pool"
```

## bitbucket OIDC 설정값들 확인

Bitbucket Repository 화면에서 왼쪽 아래 `Repository settings` 메뉴를 클릭하면, 아래와 같이 OpenID Connect라는 메뉴에 접근할 수 있다.

<img src="/static/images/bitbucket-settings-oidc.png" alt="bitbucket oidc settings" />

issuer-uri와 allowed-audiences 설정값을 위에서 확인한 값으로 설정한다. 그리고 [attribute-mapping은 GCP 문서에 설명한 대로](https://cloud.google.com/iam/docs/workload-identity-federation#mapping) 설정을 한다. Bitbucket에서 발급하는 Token의 payload에 sub, workspaceUuid, respositoryUuid등이 claims로 저장되어 있다. [이 글을 확인하면 어떤 claims들이 있는지 예제를 확인할 수 있다.](https://support.atlassian.com/bitbucket-cloud/docs/integrate-pipelines-with-resource-servers-using-oidc/) custom attribute로 attribute.repository_uuid를 설정했는데, 해당 attribute로 특정 repository만 권한을 받을 수 있게 설정할 수 있다.

```bash
gcloud iam workload-identity-pools providers create-oidc bitbucket-provider \
--location="global" \
--workload-identity-pool="bitbucket-pool" \
--issuer-uri="https://api.bitbucket.org/2.0/workspaces/myworkspace/pipelines-config/identity/oidc" \
--allowed-audiences="ari:cloud:bitbucket::workspace/31c366db-0cb6-454a-8c0a-6d174be5c298" \
--attribute-mapping="google.subject=assertion.sub,attribute.workspace_uuid=assertion.workspaceUuid,attribute.repository_uuid=assertion.repositoryUuid"
```

## Service Account 생성 및 권한 부여

```bash
gcloud iam service-accounts create bitbucket-sa
```

이번 예제에서는 GCP Artifact Registry에 Container Image를 push할 수 있도록 Role을 부여한다.

```bash
gcloud artifacts repositories add-iam-policy-binding ${REPO_NAME} \
--location us-west1 \
--member serviceAccount:bitbucket-sa@${MY_PRJ_NAME}.iam.gserviceaccount.com \
--role roles/artifactregistry.writer
```

## Repository별로 role binding

위에서 custom attribute `resposiory_uuid`를 추가했었다. 따라서 특정 Bitbucket Repository의 UUID와 동일한 경우에만 Service Account impersonation으로 Access Token을 발급할 수 있도록 아래와 같이 설정한다. 여기서 주의해야할 점은 repository_uuid가 `{}`도 포함된다는 점이다.

```bash
gcloud iam service-accounts add-iam-policy-binding \
--role roles/iam.serviceAccountTokenCreator \
--member "principalSet://iam.googleapis.com/projects/${MY_PRJ_ID}/locations/global/workloadIdentityPools/bitbucket-pool/attribute.repository_uuid/{02ac571e-4a7f-415a-bc5a-10fec861d9a6}" \
bitbucket-sa@${MY_PRJ_NAME}.iam.gserviceaccount.com
```

## Bitbucket Pipeline YAML 작성

`bitbucket-pipelines.yml`을 아래와 같이 작성한다. `BITBUCKET_STEP_OIDC_TOKEN`을 사용하려면 `oidc: true`를 설정해야 한다. 위에서 IAM Policy Binding을 정상적으로 진행하지 않으면, Access Token을 발급하지 못하여 에러가 발생한다. 정상적으로 설정이 완료되었다면 Artifact Repository에 새로 빌드된 컨테이너 이미지를 Push할 수 있다.

```yaml
pipelines:
  branches:
    main:
      - step:
          name: Example
          oidc: true
          image: google/cloud-sdk
          script:
            - echo ${BITBUCKET_STEP_OIDC_TOKEN} > /tmp/gcp_access_token.out
            - gcloud iam workload-identity-pools create-cred-config projects/${MY_PRJ_ID}/locations/global/workloadIdentityPools/bitbucket-pool/providers/bitbucket-provider --service-account="bitbucket-sa@${MY_PRJ_NAME}.iam.gserviceaccount.com" --output-file=${BITBUCKET_CLONE_DIR}/gcp_temp_cred.json --credential-source-file=/tmp/gcp_access_token.out
            - gcloud auth login --cred-file=${BITBUCKET_CLONE_DIR}/gcp_temp_cred.json
            - gcloud auth configure-docker us-west1-docker.pkg.dev --quiet
            - docker build -t us-west1-docker.pkg.dev/${MY_PRJ_NAME}/${REPO_NAME}/tutorial:${BITBUCKET_COMMIT} .
            - docker push us-west1-docker.pkg.dev/${MY_PRJ_NAME}/${REPO_NAME}/tutorial:${BITBUCKET_COMMIT}
          services:
            - docker
```

## 결론

Service Account의 key를 발급해서 사용하는 것을 지양하고, 임시 credential를 사용하는 것이 바람직하다. Github Action이나 Bitbucket Pipeline을 사용하여 Cloud에 리소스를 배포/변경할 때, 만료기간이 없는 Key 발급하여 사용하는 대신에 OIDC를 통해서 임시 credential를 사용할 수 있다. 이번 글에서는 다른 누군가 Bitbucket OIDC로 GCP에 접근하도록 설정할 때, 참고할 수 있는 완전한 예제를 작성해보았다.
