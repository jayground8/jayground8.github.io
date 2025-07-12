---
title: 'GCP IAM으로 MySQL 접속하기'
date: '2025-01-26'
tags: ['gcp', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'GCP의 관리형 데이터베이스 서비스인 SQL의 User를 관리할 때, 제약사항이 없다면 IAM 인증을 활용하는 것을 고려하자. Google Workspace를 사용하고 있다면, 이미 생성된 구글 이메일 계정과 Group을 통해서 데이터베이스 접속 권한을 제어할 수 있다. 데이터베이스 User를 비밀번호 인증으로 생성하여 관리하는 대신에, 구글 계정으로 인증하여 데이터베이스를 접속할 수 있도록 관리하자. 이번 글에서는 IAM 인증을 위한 설정 방법을 설명한다.'
---

대부분의 Public Cloud Provider들은 관리형 데이터베이스 서비스를 제공한다. GCP에서는 관리형 데이터베이스 서비스로 SQL가 존재한다. 이렇게 클라우드 환경에서 관리형 데이터베이스 서비스를 사용할 때, 데이터베이스에 접속할 계정은 어떻게 관리하는 것이 좋을까? 데이터베이스 user를 생성해서 user이름과 비밀번호를 전달하여 접속하도록 하면 될까? 아직도 이렇게 하는 것을 우선 고려하는 경우를 보게 된다. 따라서 오늘은 GCP에서 SQL를 사용할 때 어떻게 계정 관리를 하는게 좋을지 알아본다.

## 예제 환경

- GCP
- Google Workspace 사용
- SQL(MySQL) 사용
- [GCP cli 설치](https://cloud.google.com/sdk/docs/install?hl=ko)
- [Google SQL Auth Proxy 설치](https://cloud.google.com/sql/docs/mysql/connect-auth-proxy#install)

## 비밀번호 인증의 단점

대부분의 경우에는 클라우드에서 관리형 데이터베이스 서비스를 사용할 때, 외부 인터넷으로 접속하지 못하도록 VPC안에서만 접속할 수 있도록 설정한다. 외부 인터넷으로 접속할 수 있도록 Bastion instance를 통해 ssh tunneling 접속하거나, VPN을 설정하여 데이터베이스 접속하도록 설정한다. 이렇게 외부 인터넷으로 데이터베이스에 접속하는 것을 통제한다. 이번 글에서는 세부적으로 어떻게 설정했는지 무시하고, 우리는 데이터베이스에 연결할 수 있는 상태로 가정한다.

이제 데이터베이스에 접속하기 위해서 생성된 user와 비밀번호로 인증을 수행한다. 데이터베이스에 접속해야 되는 사람들이 생길 때마다 비밀번호 인증방식으로 user를 생성해서 전달한다. 이렇게 데이터베이스 user를 관리할 때, 아래와 같은 단점들이 존재한다.

- 비밀번호는 고정된 값이다. 비밀번호를 주기적으로 값을 변경해주지 않으면 한번 설정된 고정값이 계속 유지된다.
- 접속해야 되는 새로운 사람이 생기거나 권한을 회수해야 되는 사람이 생기면 user를 생성하거나 삭제해야 한다.

## IAM 인증으로 개선

Google Workspace를 사용하고 있다면, 이미 사용하고 있는 구글 이메일 계정과 Group등을 활용하여 위의 단점을 개선할 수 있다.

1. 데이터베이스 User를 직접 생성&삭제하지 않고, 기존에 사용중인 구글 이메일 계정으로 데이터베이스에 접근을 허용&제한 할 수 있다.
2. 구글 Group을 통해서 데이터베이스 권한을 설정하여 관리할 수 있다.
3. 만료기간이 있는 임시값으로 인증을 수행한다. 보안을 위해서 데이터베이스 User 비밀번호를 주기적으로 교체하는 것을 따로 구현하지 않아도 된다.

## IAM 인증 설정 방법

1. [Google Admin Console](https://admin.google.com)에서 Group 생성. (`tutorial`로 생성했다고 가정한다.)

<img src="/static/images/sql-admin-console.png" alt="google admin console" />

2. 위에서 생성한 Group에 MySQL 접속을 허용한 구글 이메일 계정을 Member로 추가. (`jayground8@yourdomain.com`을 추가했다고 가정한다.)

3. 필요한 IAM role을 group에 할당

```bash
gcloud projects add-iam-policy-binding my-prj \
--member=group:tutorial@yourdomain.com \
--role=roles/cloudsql.instanceUser
```

```bash
gcloud projects add-iam-policy-binding my-prj \
--member=group:tutorial@yourdomain.com \
--role=roles/cloudsql.client
```

1. Cloud IAM 인증방식으로 새로운 데이터베이스 User 추가. (IAM principal을 아래와 같이 group으로 설정한다.)

<img src="/static/images/sql-add-user.png" alt="add new user with Cloud IAM" />

5. root user로 데이터베이스 접속하여 해당 user에 권한을 부여.

```sql
grant select on *.* to "tutorial"@"yourdomain.com";
```

6. 구글 workspace 이메일 계정으로 로그인

```bash
gcloud auth application-default login
```

7. Cloud SQL Proxy로 SQL에 접속

```bash
cloud-sql-proxy --auto-iam-authn --private-ip my-prj:us-west1:tutorial-db
```

정상적으로 접속이 되면 아래와 같은 로그들은 터미널에서 확인할 수 있다.

```bash
2025/01/21 12:32:52 Authorizing with Application Default Credentials
2025/01/21 12:32:53 [my-prj:us-west1:tutorial-db] Listening on 127.0.0.1:3306
2025/01/21 12:32:53 The proxy has started successfully and is ready for new connections!
```

8. 데이터베이스를 접속 가능하도록 설정하여(VPN) client로 접속. (jayground8@yourdomain.com이라면 앞의 jayground8으로 접속한다.)

```bash
mysql -h 127.0.0.1 -u jayground8
```

## 결론

클라우드 환경에서는 최대한 IAM 인증을 활용하면 보안적으로 유리할 뿐만 아니라, 관리 측면에서도 장점을 가져온다. 따라서 클라우드 환경에서 관리형 데이터베이스를 사용할 때, 클라우드 IAM인증 방식을 제공한다면 최대한 활용하는 것이 바람직하겠다. 특히 GCP의 경우에는 Googe Workspace의 이메일 계정과 Group을 연결하여 권한을 설정할 수 있다. 따라서 이미 Google Workspace를 쓰고 있다면, 별도로 데이터베이스 user들을 생성해서 관리하지 말고 이미 관리되는 Google 이메일 계정과 Group을 통해서 데이터베이스 접근 관리를 하자.
