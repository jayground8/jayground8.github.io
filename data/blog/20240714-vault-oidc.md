---
title: '구글 계정으로 Vault 로그인하기'
date: '2024-07-14'
tags: ['vault', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'Vault를 구글 인증을 통해서 로그인하도록 설정해본다. Admin Directory API를 통해서 workspace의 user와 group의 정보를 가져올 수 있고, 해당 정보를 통해서 인증 조건을 추가할 수 있다. 예로 특정 workspace group에 속한 계정만 인증에 성공할 수 있도록 조건을 추가할 수 있다. Admin Directory API에 요청하기 위해서 필요한 권한을 설정할 수 있는데, Service Account의 key 파일을 생성하는 대신에, Application Default Credentials를 활용해보았다. Application Default Credentials를 사용하는 과정에서 삽질을 많이 했는데, 혹시나 동일한 작업을 하는 분들은 나처럼 시간을 허비하지 않기를 바라며 글을 작성한다.🥹'
---

Google Workspace를 사용하는 경우 Google 계정으로 통합해서 인증을 하는 것을 고민해볼 수 있다. Vault에서도 인증방법으로 OIDC를 제공하고 있기 때문에, Google 계정으로 인증하여 권한을 받을 수 있다. [Vault 문서에서 설정을 어떻게 하는지 친절하게 설명](https://developer.hashicorp.com/vault/docs/auth/jwt/oidc-providers/google)하고 있다. 따라서 간단하게 설정이 완료될 것이라 예상했지만, 이런 저런 삽질을 하면서 또 다른 삽질기가 되었다. 혹시가 동일한 작업을 할 때, 다른 사람들은 시간을 덜 허비하길 바라면서 정리해서 글을 올려본다.

Oauth2로 인증을 하고, [Google Workspace Directory API](https://developers.google.com/admin-sdk/directory/reference/rest)를 통해서 user정보와 group정보를 가져와서 추가적인 조건을 줄 수가 있다. 예를 들어서 Google workspace의 vault group에 있는 계정만 인증에 성공하도록 설정할 수 있다.

## Oauth 2.0 Client 생성

`GCP 콘솔`에서 아래 그림처럼 `Web application` 타입으로 생성한다.

<img src="/static/images/vault-oidc-oauth2.png" alt="add Oauth2.0 Client" />

redirect url를 아래와 같은 path로 등록을 해준다.

```bash
http://localhost:8000/ui/vault/auth/oidc/oidc/callback
http://localhost:8000/oidc/callback
```

## Service Account 생성

`GCP 콘솔`에서 Service Account를 생성한다.

<img src="/static/images/vault-oidc-service-account.png" alt="create new service account" />

## 설정 옵션

세 가지 방법으로 Google Workspace의 User와 Group 정보를 가져오는 것을 설정할 수 있다.Role을 연결하는 대신에 domain-wide delegation으로 권한을 주는 것이 관리 측면에서 편하다. 그리고 static하게 service account key 파일을 생성하는 것보다, Refresh Token를 사용하는 Application Default Credentials이 조금 더 보안적으로 유리하다고 본다. 따라서 세 번째 방법으로 설정하는 것을 설명한다.

1. service account key를 생성 + 해당 service account에 Role을 부여
2. service account key를 생성 + domain-wide delegation 설정
3. service account key를 생성하는 대신에 ADC를 이용 + domain-wide delegation 설정

## 방법 3

### Directory API 권한 부여

Directory API를 통해서 user와 group정보를 가져오기 위해서 아래와 같은 scope이 설정되어야 한다.

```bash
https://www.googleapis.com/auth/admin.directory.group.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
```

Domain wide delegation 방식으로 권한을 부여하기 위해서 아래와 같이 Workspace Admin 콘솔에서 부여한다. 위의 두가지 scope를 사용할 Service Account ID에 추가해준다.

<img src="/static/images/vault-oidc-domain-wide-delegation.png" alt="Domain Wide Delegation" />

### 필요한 Service 사용하도록 설정

ADC(Application Default Credentials)에서 사용할 서비스를 `enable` 해준다.

```bash
gcloud services enable iamcredentials.googleapis.com
```

### Service Account에 필요한 권한 부여

ADC(Application Default Credentials) 방법으로 accessToken을 받아오기 위해서는 Service Account에 필요한 권한을 설정해야 한다. 따라서 이미 GCP에 만들어진 Role을 Service Account에 부여해준다.

```bash
gcloud projects add-iam-policy-binding {project ID} --member=serviceAccount:{service account명}@{proejct ID}.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator
gcloud projects add-iam-policy-binding {project ID} --member=serviceAccount:{service account명}@{proejct ID}.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
```

ADC를 사용할 때 roles/iam.serviceAccountUser를 부여하지 않아서 계속 권한 에러가 발생했었다. [Service Account를 사용할 때 해당 Role이 부여되어야지 해당 Service Account가 리소스에 접근할 수 있다.](https://cloud.google.com/iam/docs/service-account-permissions#roles)

### local ADC 파일 생성

아래와 같은 명령어로 local ADC 파일을 생성할 수 있다.

```bash
gcloud auth application-default login --impersonate-service-account {service account명}@{proejct ID}.iam.gserviceaccount.com
```

아래와 같은 경로에 파일이 생성된 것을 확인할 수 있다.

```bash
cat ~/.config/gcloud/application_default_credentials.json
```

파일은 아래와 같은 값을 가지고 있다. `https://iamcredentials` 경로로 url이 설정된 것을 볼수가 있고, refresh_token 값도 있는 것을 볼 수가 있다.

```json
{
  "delegates": [],
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{service account명}@{proejct ID}.iam.gserviceaccount.com:generateAccessToken",
  "source_credentials": {
    "account": "",
    "client_id": "{client ID}",
    "client_secret": "{client secret}",
    "refresh_token": "{refresh Token}",
    "type": "authorized_user",
    "universe_domain": "googleapis.com"
  },
  "type": "impersonated_service_account"
}
```

### Vault 설정

Vault를 kubernetes에서 운영하고 있다면 Vault pod에 접근하여 위에서 만든 Local ADC 파일을 동일한 경로로 저장해준다.

```bash
mkdir -p ~/.config/gcloud
vi ~/.config/gcloud/application_default_credentials.json
```

oidc 설정값을 아래와 같이 설정한다.

```bash
vault write auth/oidc/config -<<EOF
{
    "oidc_discovery_url": "https://accounts.google.com",
    "oidc_client_id": "{생성한 oauth2 client ID}",
    "oidc_client_secret": "{생성한 oauth2 client secret}",
    "default_role": "sample",
    "provider_config": {
            "provider": "gsuite",
            "fetch_groups": true,
            "groups_recurse_max_depth": 5,
            "domain": "{workspace domain 이름}",
            "gsuite_admin_impersonate": "{구글 계정}",
            "impersonate_principal": "{service account 이름}@{project ID}.iam.gserviceaccount.com"
    }
}
EOF
```

그리고 role에 대해서 특정 workspace group에 속한 경우만 인증이 되도록 설정한다. `user_claim`을 email로 하기 위해서는 `oidc_scopes`에 `email`를 추가해줘야 한다.

```bash
vault write auth/oidc/role/sample -<<EOF
{
  "allowed_redirect_uris": "http://localhost:8000/ui/vault/auth/oidc/oidc/callback,http://localhost:8000/oidc/callback",
  "oidc_scopes": [
    "openid",
    "email",
  ],
  "user_claim": "email",
  "groups_claim": "groups",
  "bound_claims": {
    "groups": ["{group명}@{workspace 도메인명}"]
  }
}
EOF
```

### Vault OIDC Login

설정이 정상적으로 되었다면 아래의 화면에서 정상적으로 로그인이 된다.

<img src="/static/images/vault-oidc-ui.png" alt="vault oidc login page" />

## 방법 2

### Service Account key 파일 사용

GCP 콘솔에서 Service Account Key를 발급하여 사용한다고 하면 먼저 원하는 경로에 해당 파일을 복사한다. 예를 들어서 Home Directory에 service-account.json 파일로 생성했다면, `gsuite_service_account`에 해당 경로를 설정한다. 그러면 이제 service account key file을 통해서 Directory API에 접근한다. 이번에는 domain wide delegation 방식으로 권한을 주지 않도록 `impersonate_principal`와 `gsuite_admin_impersonate` 설정은 하지 않았다.

```bash
vault write auth/oidc/config -<<EOF
{
    "oidc_discovery_url": "https://accounts.google.com",
    "oidc_client_id": "{생성한 oauth2 client ID}",
    "oidc_client_secret": "{생성한 oauth2 client secret}",
    "default_role": "sample",
    "provider_config": {
            "provider": "gsuite",
            "gsuite_service_account": "/home/vault/service-account.json",
            "fetch_groups": true,
            "groups_recurse_max_depth": 5,
            "domain": "{workspace domain 이름}"
    }
}
EOF
```

### Role 부여

[아래처럼 웹 페이지의 오른쪽에 있는 창으로 API 요청을 바로 테스트 할 수 있다.](https://developers.google.com/admin-sdk/directory/reference/rest/v1/roles/list)

<img src="/static/images/vault-oidc-role.png" alt="Request Role List On Web" />

요청을 해보면 Admin Directory Role들이 보이고, 그중에서 필요한 권한이 있는 `_GROUPS_ADMIN_ROLE`를 사용한다.

```json
{
  "kind": "admin#directory#role",
  "etag": "\"d9aT4dOLOjokkvLTmm9XBfjJDibmEEBPEGlwx1-6rsA/iUlV2qBguyme9hsqIzEaTwZJ7J8\"",
  "roleId": "39020349843721106",
  "roleName": "_GROUPS_ADMIN_ROLE",
  "roleDescription": "Groups Administrator",
  "rolePrivileges": [
    {
      "privilegeName": "GROUPS_ALL",
      "serviceId": "-"
    },
    {
      "privilegeName": "GROUPS_MANAGE_LOCKED_LABEL",
      "serviceId": "-"
    },
    {
      "privilegeName": "GROUPS_MANAGE_SECURITY_LABEL",
      "serviceId": "-"
    },
    {
      "privilegeName": "ORGANIZATION_UNITS_RETRIEVE",
      "serviceId": "-"
    },
    {
      "privilegeName": "USERS_RETRIEVE",
      "serviceId": "-"
    },
    {
      "privilegeName": "ADMIN_DASHBOARD",
      "serviceId": "-"
    }
  ],
  "isSystemRole": true,
  "isSuperAdminRole": false
}
```

[동일한 방식으로 이제 RoleAssignment API를 웹 화면에서 바로 요청 한다.](https://developers.google.com/admin-sdk/directory/reference/rest/v1/roleAssignments/insert) `assignedTo`를 service account의 cleint ID를 설정하여 해당 Role이 부여되도록 요청한다.

```json
{
  "assignedTo": "{service account client ID}",
  "roleId": "39020349843721106",
  "scopeType": "CUSTOMER",
  "kind": "admin#directory#roleAssignment"
}
```

## 결론

Google Workspace를 사용한다면 Vault OIDC 인증 방식을 사용하는 것이 좋겠다. Application Default Credentials방식에서 사용되는 RefreshToken의 만료기간이나 회수조건에 대해서는 더 알아봐야겠지만, Static하게 Service Account Key를 발급받는 것보다는 더 좋은 방법이라고 생각이 든다. 따라서 ADC를 활용해서 설정을 해보고 싶었다. 하지만 그 과정에서 필요한 권한들을 부여하지 않아서 Workspace의 User와 Group 정보를 가져오는데 권한문제가 발생했다. 또 한번 삽질을 통해서 올바른 설정 방법을 알게 되었다.😭
