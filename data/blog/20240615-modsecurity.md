---
title: 'ModSecurity를 Nginx Ingress Controller에 연동하여 WAF 설정하기'
date: '2024-06-15'
tags: ['kubernetes', 'nginx', 'modsecurity', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'ModSecurity는 오픈소스로 제공하는 WAF이다. Nginx connector를 통해서 ModSecurity를 Nginx에 쉽게 연동할 수 있다. Nginx Ingress Controller에서는 해당 설정을 할 수 있도록 Configmap에 설정 옵션들을 제공한다. 해당 옵션들을 설정함으로서 쉽게 Nginx에 WAF를 구현할 수 있다. ModSecurity는 Trustware라는 회사가 관리하다가 2024년 1월에 OWASP foundation으로 넘어가게 되었다. ModSecurity는 오래된 프로젝트이고, Production Ready라고 소개되고 있다. 하지만 ModSecurity가 앞으로도 계속 커뮤니티를 통해서 활발히 관리될지는 지켜봐야겠다.'
---

## WAF

Kubernetes에서 Nginx Ingress Controller를 사용하고 있을 때, WAF가 필요하다고 하면 어떻게 해야 할까? [Nginx Ingress Controller 문서](https://kubernetes.github.io/ingress-nginx/user-guide/third-party-addons/modsecurity/)에서 친절하게 [ModSecurity](https://github.com/owasp-modsecurity/ModSecurity)를 통해서 WAF를 적용할 수 있다고 설명이 되어 있다.

[https://www.modsecurity.org/](https://www.modsecurity.org/)로 접속을 해보면 아래와 같이 설명이 되어 있다.

<img src="/static/images/modsecurity-webpage.png" alt="annoucement on a modsecurity webpage" />

Trustwave가 관리하던 해당 software를 2024년 1월부터 OWASP에서 담당하게 되었다고 한다. Trustwave가 Community version도 관리하면서 Enterprise Support를 제공하고 있었던 것 같다. 오픈소스 소프트웨어를 도입할 때는 해당 소프트웨어가 지속적으로 관리가 될 수 있을지 판단하게 된다. Nginx, Vault, Cilium, Grafana등은 Community 버전과 함께 특정 회사에서 Enterprise Support를 같이 제공한다. 특정 기능들이 Enterprise 라이센스에서만 제공되는 한계가 있지만, 그래도 해당 Community version도 담당하기 때문에 어느 정도 신뢰를 가지고 사용할 수 있었다. 또한 CNCF에 속한 프로젝트도 어느정도 신뢰를 가지고 사용할 수 있었다.

ModSecurity는 계속해서 커뮤니티에서 관리가 될 수 있는 프로젝트일까? [여기에는 OWASP foundation에서 관리하는 프로젝트들이](https://owasp.org/projects/) 나와있다. 나에게 익숙한 프로젝트는 많지 않았다. 예전에 Supply Chain Security와 BOM에 대해서 조사할 때 봤던 CycloneDX 정도만 알고 있다. 그런데 [OWSAP에서 다른 WAF 프로젝트인 Coraza](https://coraza.io/)도 존재한다. Nginx Ingress Controller에서는 해당 WAF 설정을 지원하지 않는 것으로 보이는데, 아직 [OWSAP Coraza을 위한 Nginx Connector가 Production Ready로 준비된게 없는 것](https://github.com/corazawaf/coraza-nginx)으로 보인다. [ModSecurity의 마지막 배포된 버전은 2024년 1월 31일에 배포된 v3.0.12 이다.](https://github.com/owasp-modsecurity/ModSecurity/releases) 앞으로 계속해서 새로운 버전이 배포가 되는지 확인을 해봐야겠다.

## 설치

Nginx 설정을 Configmap으로 설정할 수 있는데, [공식 문서](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/)에서 어떤 옵션들이 있는지 확인할 수 있다. 설정 옵션들 중에 `ModSecurity`에 관련된 옵션은 아래와 같다.

- enable-modsecurity
- enable-owasp-modsecurity-crs
- modsecurity-snippet

`modsecurity-snippet`으로는 ModSecurity 설정들을 할수 있는데, [설정값들은 Github Wiki 문서](https://github.com/owasp-modsecurity/ModSecurity/wiki/Reference-Manual-%28v2.x%29#user-content-SecAuditEngine)에서 확인할 수 있다.

`SecRuleEngine` 설정으로 Rule이 적용될것인지 결정할 수 있다. `DetectionOnly`는 rule에 의해서 traffic에 영향이 가지 않고, 그냥 감지만 할 수 있다. `On`으로 설정하게 되면 Rule에 따라서 Traffic이 막힐 수도 있다. 따라서 처음에는 영향이 가지 않도록 `DetectionOnly`로 설정하여 확인해볼 수 있다.

- On: process rules
- Off: do not process rules
- DetectionOnly: process rules but never executes any disruptive actions (block, deny, drop, allow, proxy and redirect)

그리고 `AuditLog` 설정을 통해서 로그들을 남길 수 있다.

- SecAuditLog
- SecAuditLogFormat
- SecAuditEngine

최종적으로 Nginx Ingress Controller Helm value를 아래와 같이 정의할 수 있다. audit log를 JSON 형식으로 stdout으로 남기게 된다. 그리고 `SecAuditEngine`을 `RelevantOnly`라고 설정을 했는데, `SecAuditLogRelevantStatus "^(?:5|4(?!04))"`로 기본 설정되어 있기 때문에 404빼고 4xx, 5xx status code에 대해서 log를 남기게 된다. 그리고 rule은 [OWASP ModSecurity Core Rule Set](https://owasp.org/www-project-modsecurity-core-rule-set/)이 적용되도록 `enable-owasp-modsecurity-crs`을 true로 설정하였다.

```yaml
controller:
  config:
    enable-modsecurity: true
    enable-owasp-modsecurity-crs: true
    modsecurity-snippet: |
      SecRuleEngine DetectionOnly
      SecStatusEngine Off
      SecAuditLog /dev/stdout
      SecAuditLogFormat JSON
      SecAuditEngine RelevantOnly
```

최종 설정된 설정값은 Nginx controller container에서 아래 경로로 저장되어 있다.

```bash
cat /etc/nginx/modsecurity/modsecurity.conf
```

그리고 Rule들이 아래의 경로로 저장되어 있다.

```bash
ls /etc/nginx/owasp-modsecurity-crs/rules
```

## 동작 확인

위의 values 적용하여 Helm으로 ModSecurity에 대한 설정값을 반영한다. 그러면 아래와 같이 stdout으로 log가 남는 것을 확인할 수 있다. HTTP PUT method로 요청이 왔을 때, OWASP ModSecurity Core Rule에 의해서 감지가 된 것이다.

```json
{
  "transaction": {
    "client_ip": "10.2.3.43",
    "time_stamp": "Fri Jun 14 11:20:00 2024",
    "server_id": "4c0ebcf3510333a0fbab30ac91370a728678087c",
    "client_port": 61320,
    "host_ip": "10.2.3.150",
    "host_port": 443,
    "unique_id": "171835464041.816920",
    "request": {
      "method": "PUT",
      "http_version": 1.1,
      "uri": "/test",
      "body": "",
      "headers": {
        "Host": "example.com",
        "User-Agent": "python-requests/2.19.1",
        "Accept-Encoding": "gzip, deflate",
        "Accept": "*/*",
        "Connection": "keep-alive",
        "Content-Length": "0"
      }
    },
    "response": {
      "http_code": 200,
      "headers": {
        "Referrer-Policy": "no-referrer",
        "Origin-Agent-Cluster": "?1",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-DNS-Prefetch-Control": "off",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": "2",
        "Date": "Fri, 14 Jun 2024 11:20:00 GMT",
        "Server": "",
        "Server": "",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "ETag": "W/\"2-eoX0dku9ba8cNUXvu/DyeabcC+s\"",
        "X-Content-Type-Options": "nosniff",
        "X-Download-Options": "noopen",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Permitted-Cross-Domain-Policies": "none",
        "X-XSS-Protection": "0",
        "X-Request-IP": "10.2.3.43"
      }
    },
    "producer": {
      "modsecurity": "ModSecurity v3.0.8 (Linux)",
      "connector": "ModSecurity-nginx v1.0.3",
      "secrules_engine": "DetectionOnly",
      "components": ["OWASP_CRS/3.3.5\""]
    },
    "messages": [
      {
        "message": "Method is not allowed by policy",
        "details": {
          "match": "Matched \"Operator `Within' with parameter `GET HEAD POST OPTIONS' against variable `REQUEST_METHOD' (Value: `PUT' )",
          "reference": "v0,3",
          "ruleId": "911100",
          "file": "/etc/nginx/owasp-modsecurity-crs/rules/REQUEST-911-METHOD-ENFORCEMENT.conf",
          "lineNumber": "28",
          "data": "PUT",
          "severity": "2",
          "ver": "OWASP_CRS/3.3.5",
          "rev": "",
          "tags": [
            "application-multi",
            "language-multi",
            "platform-multi",
            "attack-generic",
            "paranoia-level/1",
            "OWASP_CRS",
            "capec/1000/210/272/220/274",
            "PCI/12.1"
          ],
          "maturity": "0",
          "accuracy": "0"
        }
      },
      {
        "message": "Inbound Anomaly Score Exceeded (Total Score: 5)",
        "details": {
          "match": "Matched \"Operator `Ge' with parameter `5' against variable `TX:ANOMALY_SCORE' (Value: `5' )",
          "reference": "",
          "ruleId": "949110",
          "file": "/etc/nginx/owasp-modsecurity-crs/rules/REQUEST-949-BLOCKING-EVALUATION.conf",
          "lineNumber": "81",
          "data": "",
          "severity": "2",
          "ver": "OWASP_CRS/3.3.5",
          "rev": "",
          "tags": ["application-multi", "language-multi", "platform-multi", "attack-generic"],
          "maturity": "0",
          "accuracy": "0"
        }
      }
    ]
  }
}
```

아래처럼 `tx.allowed_methods` 에 정의된 method만 허용가능하도록 Rule이 설정되어 있다.

`REQUEST-949-BLOCKING-EVALUATION.conf`

```bash
SecRule REQUEST_METHOD "!@within %{tx.allowed_methods}" \
    "id:911100,\
    phase:2,\
    block,\
    msg:'Method is not allowed by policy',\
    logdata:'%{MATCHED_VAR}',\
    tag:'application-multi',\
    tag:'language-multi',\
    tag:'platform-multi',\
    tag:'attack-generic',\
    tag:'paranoia-level/1',\
    tag:'OWASP_CRS',\
    tag:'capec/1000/210/272/220/274',\
    tag:'PCI/12.1',\
    ver:'OWASP_CRS/3.3.5',\
    severity:'CRITICAL',\
    setvar:'tx.anomaly_score_pl1=+%{tx.critical_anomaly_score}'"
```

그리고 `allowed_methods`는 아래와 같은 Method만 정의가 되어 있다. 따라서 PUT은 허용되지 않았다.

```bash
tx.allowed_methods=GET HEAD POST OPTION
```

이제 `SecAction`을 통해서 `allowed_methods`를 아래와 같이 원하는 값으로 override하도록 설정한다. 그리고 다시 Helm으로 해당 value로 업그레이드를 한다.

```yaml
config:
  enable-modsecurity: true
  enable-owasp-modsecurity-crs: true
  modsecurity-snippet: |
    SecRuleEngine DetectionOnly
    SecStatusEngine Off
    SecAuditLog /dev/stdout
    SecAuditLogFormat JSON
    SecAuditEngine RelevantOnly
    SecAction "id:900200,phase:1,nolog,pass,t:none,setvar:'tx.allowed_methods=GET HEAD POST OPTIONS PUT'"
```

그러면 이제 stdout으로 남던 log가 사라진것을 확인할 수 있다.

`SecRule`을 통해서 원하는 custom rule들을 추가할 수 있는데, 아래는 local network로 오는 경우에는 RuleEngine을 Off하도록 정의한 예이다.

```bash
SecRule REMOTE_ADDR "@ipMatch 127.0.0.1" "id:87,phase:1,pass,nolog,ctl:ruleEngine=Off"
```

## 결론

오픈소스 WAF인 ModSecurity 덕분에 빠르게 Nginx에 WAF를 구현할 수 있었다. 해당 프로젝트가 OWSAP Foundation으로 이관되고 어떻게 관리되는지 계속해서 관심을 가져야겠다.
