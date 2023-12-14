---
title: 'Argo CD Notification으로 간단하게 Slack 알림 보내기'
date: '2023-12-14'
tags: [Kubernetes, ArgoCD]
images: ['/static/images/social-banner.png']
summary: 'Argo CD Notification가 이미 있어서 쉽게 Slack 알림을 연동할 수 있다. 메뉴얼에서 친절하게 셋팅 방법을 설명하고 있지만, 처음 보고 셋팅할 때 놓칠 수 있는 부분을 기록으로 남긴다.'
---

[argo CD notification](https://argocd-notifications.readthedocs.io/en/stable/)에서 친절하게 설명이 되어 있지만, 메뉴얼을 따라하면서 실수 할 수 있는 부분을 기록으로 남긴다.

## Slack Permission

Bot Token Scopes에서 Bot User로 보내기 위해서 `chat:write.publi` permission도 같이 부여 한다.

<img src="/static/images/argocd-notification-slack-permission.png" alt="argocd notification slack permission" />

그리고 아래처럼 Bot User Oauth Token을 사용하여, App이 채널에 message를 보낼 수 있도록 한다.

<img src="/static/images/argocd-notification-slack-token.png" alt="argocd notification slack token" />

## Kubernetes 설치

Argo CD notifcation controller을 아래처럼 설치한다.

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj-labs/argocd-notifications/release-1.0/manifests/install.yaml
```

그리고 아래처럼 ConfigMap을 설치한다. `argocd-notifications-cm` ConfigMap에 알림을 보낸 message template들이 설정된다.

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj-labs/argocd-notifications/release-1.0/catalog/install.yaml
```

위에서 설정한 `Bot User Oauth Token`을 `<auth-token>`에 넣어서 생성한다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
stringData:
  slack-token: <auth-token>
```

그리고 이미 ConfigMap이 만들어져 있기 때문에, patch를 통해서 slack 설정을 추가한다.

```bash
kubectl patch cm argocd-notifications-cm -n argocd --type merge -p '{"data": {"service.slack": "{ token: $slack-token }" }}'
```

마지막으로 이미 ArgoCD에서 만들어진 App에 notification을 적용하고 싶으면, Annotation을 추가하면 된다. 아래처럼 ArgoCD CRD를 확인할 수 있다.

```bash
$ kubectl get app

NAME           SYNC STATUS   HEALTH STATUS
sample         Synced        Healthy
```

sync가 성공적으로 되었을 때, Slack notification을 보내고 싶으면 아래와 같이 annotation을 넣으면 된다.

```bash
kubectl patch app sample -p '{"metadata": {"annotations": {"notifications.argoproj.io/subscribe.on-sync-succeeded.slack":"channel_name"}}}' --type merge
```

이제 Argo CD에서 해당 Application에서 Sync가 성공적으로 진행되면 해당 슬랙 채널로 메세지가 가게 된다.

## CLI

`argocd-notification` binary로 CLI를 제공한다. Kubernetes container에서 아래와 같이 명령어로 사용할 수 있다. 이렇게 `applicaion_name`에 Argo CD application 이름을 설정하고, `channel_name`은 보내고 싶은 채널을 적으면 테스트로 메세지를 보내볼 수 있다. 위의 과정에서 슬랙 메세지가 정상적으로 오지 않으면 이 CLI로 요청해서 slack에서 어떤 응답이 오는지 확인하여 디버깅 할 수 있다. `channel_name`에 `@slack_username`으로 보내면 user conversation에 메세지를 보내서 확인할 수 있다.

```bash
kubectl exec -it argocd-notifications-controller-5d78489bc8-fkb2x -- /app/argocd-notifications template notify app-deployed application_name --recipient slack:channel_name
```

## Custom Template

Slack에 오는 message의 내용과 format을 변경하고 싶으면, 아래와 같이 내가 정의한 template를 `argocd-notifications-cm` ConfigMap에 추가하면 된다.

```yaml
template.app-deployed-custom: |
  slack:
    message: |
      {{if eq .app.metadata.name "sample"}}[test]{{end}}{{.app.metadata.name}} 정상적으로 배포가 완료되엇습니다.
    attachments: |
      [{
        "title": "{{ .app.metadata.name}}",
        "color": "#18be52",
        "fields": [
        {
          "title": "Sync Status",
          "value": "{{.app.status.sync.status}}",
          "short": true
        },
        {
          "title": "Repository",
          "value": "{{.app.spec.source.repoURL}}",
          "short": true
        },
        {
          "title": "Revision",
          "value": "{{.app.status.sync.revision}}",
          "short": true
        }
        {{range $index, $c := .app.status.conditions}}
        {{if not $index}},{{end}}
        {{if $index}},{{end}}
        {
          "title": "{{$c.type}}",
          "value": "{{$c.message}}",
          "short": true
        }
        {{end}}
        ]
      }]
```

CLI를 통해서 내가 변경한 슬랙 메세지 template이 어떻게 보이는지 확인하고

```bash
kubectl exec -it argocd-notifications-controller-5d78489bc8-fkb2x -- /app/argocd-notifications template notify app-deployed-custom application_name --recipient slack:channel_name
```

그리고 마지막으로 trigger 조건에서 내가 만든 `app-deployed-custom`을 사용하도록 수정한다.

```yaml
trigger.on-deployed: |
  - description: Application is synced and healthy. Triggered once per commit.
    oncePer: app.status.sync.revision
    send:
    - app-deployed-custom
    when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
```

이제 ArgoCD에서 새로운 revision으로 sync가 맞았을 때 슬랙 알림이 가게 된다.
