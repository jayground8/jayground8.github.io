---
title: 'AWS SAM으로 배포한 Lambda의 환경변수가 변경된 Secret Manager 값으로 반영이 안되는 문제'
date: '2023-12-17'
tags: [AWS]
images: ['/static/images/social-banner.png']
summary: 'AWS Cloudformation에서 Secret Manager의 값을 참조하도록 할 수 있다. AWS SAM을 사용하여 배포된 Lambda의 환경변수가 Secret Manager의 값을 참조하는 경우가 있었다. 그런데 Secret manager의 값을 변경하여 다시 배포하여도 변경된 값이 Lambda 환경변수에 반영이 되지 않았다.🧐 AWS SAM의 리포에 관련된 Issue가 있었고, 제안한 해결방법을 적용하였다. 살짝 삽질을 했기 때문에 기록을 남겨 본다.🤪'
---

AWS SAM Template으로 Serverless Architecture를 구성할 때, Lambda의 Runtime중에 AWS Secret Manager에서 credential을 가지고 오는 것이 아니라 Environment Variable에 crendential을 넣어서 사용하는 경우가 있었다. [Cloudformation에서 Secret Manager에 저장된 Value를 참조해서 resource를 생성하는 방법](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html)을 제공한다. Secret Manager를 사용할 경우 아래처럼 작성할 수 있다.

```yaml
Resources:
  Sample:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: sample/
      Handler: app.lambdaHandler
      Runtime: nodejs18.x
      Architectures:
        - x86_64
      Environment:
        Variables:
          SECRET: '{{resolve:secretsmanager:secretName:SecretString:keyName}}'
```

AWS Secret manager Console에서 사용하는 secret의 version ID를 아래와 같이 확인할 수 있다.

<img src="/static/images/resolve-secret-manager.png" alt="aws secret manager version id" />

아래와 같이 version id를 명시적으로 정의하지 않으면 AWSCURRENT가 default로 설정된다. 따라서 Secret의 value를 수정했으면, 최신의 수정된 version id가 자동으로 적용된다.

```
{{resolve:secretsmanager:secretName:SecretString:keyName}}
```

예를 들어서 Secret `secretName`의 `keyName` 값을 변경하고, SAM Template을 적용하면 Lambda의 Environment Variable이 변경된 값으로 반영될 거라 기대를 했다. 그런데 Lambda가 Update 되었는데도, 변경된 Secret 값이 반영되지 않고 이전 값과 동일하게 유지되었다.

찾아보니 관련된 [SAM Github Repository에 issue](https://github.com/aws/serverless-application-model/issues/1267)가 있었고, Secret Manager처럼 참조된 환경변수만 변경될 경우에는 새로운 값이 반영되지 않는다. 현재의 해결방법으로 Environment Variable에 항상 바뀌는 값을 주입하는 것을 공유하고 있다. Github Action을 사용할 때는 `GITHUB_SHA` 환경변수를 Revision parameter에 주입하게 되었다.

```yaml
Parameters:
  Revision:
    Type: String
Resources:
  Sample:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: sample/
      Handler: app.lambdaHandler
      Runtime: nodejs18.x
      Architectures:
        - x86_64
      Environment:
        Variables:
          SECRET: '{{resolve:secretsmanager:secretName:SecretString:keyName}}'
          REVISION: !Ref Revision
```
