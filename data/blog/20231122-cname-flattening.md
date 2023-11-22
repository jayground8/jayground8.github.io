---
title: 'CNAME flattening'
date: '2023-11-22'
tags: [DNS]
images: ['/static/images/social-banner.png']
summary: 'CNAME flattening이 어떻게 작동하고, 왜 사용하게 되었는지 이해하게 되었다.'
---

## CNAME flattening는 무엇인가?

DNS specification에서 Domain의 Root record로는 CNAME가 될 수 없도록 되어 있다. 만약 `jayground.com` 도메인이 있고, 나의 서버가 `59.34.124.34`이라고 하면 `A record`로 Root record를 생성할 수는 있다. 하지만 Load balancer가 `some.loadbalancer.com`를 가지고 있으면, 이걸 CNAME으로 `root record`로 등록할 수가 없다. `jayground.com`에 직접 IP address를 연결하는 것보다 CNAME을 등록할 수 있으면 서버가 변경되거나 Scale in/out될 때 유연하게 대처할 수 있다. DNS specification을 벗어나서 CNAME을 등록하도록 할 수 있지만, 이런 규격을 기대하고 만들어진 서비스에서 문제가 발생할 수도 있다. 이러한 규격을 어기지 않고 Root record로 CNAME을 등록할 수 있게 해주는 방법이 `CNAME flattening`이다. DNS resolve 과정에서 Root record를 query할 때 CNAME에 있는 도메인을 내려주는 것이 아니라, 해당 도메인에 연결된 IP address를 찾아와서 내려주게 된다. 따라서 내부적으로는 이렇게 작업이 추가되지만, 외부에서는 Root record에 `A record`가 등록된 것처럼 생각 할 수 있는 것이다.

## Custom Domain 등록

많은 SaaS product중에 개인이 가지고 있는 Domain을 등록할 수 있게 해주고 있다. Github에서는 `Github pages`라는 서비스로 간단하게 website를 publish할 수 있다. 만약 `jayground.com`의 도메인을 가지고 있다면, 먼저 `jayground.com`을 소유하고 있는지 `TXT record`를 등록해서 인증한다. 그리고 Github에서 제공하는 IP address들을 `A record`로 등록하면 된다. `https://jayground.com`로 접속을 하면 제공된 IP address로 이동하게 되고, `Github pages`에 custom domain을 등록해줬기 때문에 SSL 인증서와 같이 컨텐츠를 내려주게 된다. 이렇게 `A record`를 Root record으로 등록하게 된다.

그런데 [Webflow](https://webflow.com/)에서는 Custom domain을 등록할 때, `jayground.com`에 `A record`를 등록한다. 그리고 `www.jayground.com`에는 `CNAME`으로 `proxy-ssl.webflow.com`을 등록하게 된다. [Webflow 공식문서](https://university.webflow.com/lesson/manually-connect-a-custom-domain?topics=hosting-code-export)에서 `www.jayground.com`을 webflow 설정 페이지에서 default로 셋팅을 해야 된다고 설명하고 있다.

> Your default domain should be set to the www subdomain (e.g., www.yourdomain.com). Setting the root domain (e.g., yourdomain.com) as the default requires a different setup for your DNS records.

이제 `https://jayground.com`으로 접속을 하면 `https://www.jayground.com`으로 Redirect가 된다. 그리고 `www.jayground.com`은 CNAME으로 `proxy-ssl.webflow.com`으로 되어 있어서, SSL 인증서와 함께 컨텐츠를 내려주게 된다.

## Webflow의 default domain 변경

이제 문제는 Webflow에서 default가 `www.jayground.com`이 아니라 `jayground.com`으로 사용하고 싶은 경우이다. 이때는 `CNAME flattening`을 통해서 할 수가 있다. 이제 DNS에서 `jaygroud.com`과 `www.jayground.com` 둘 다 CNAME으로 `proxy-ssl.webflow.com`으로 등록하고, Webflow에서 `jayground.com`을 Default로 설정하면 된다. 가비아에서 제공하는 DNS으로는 이렇게 `CNAME flattening`이 가능해서 CNAME을 등록하면, `https://www.jayground.com`에 접근을 할 때 `https://jayground.com`으로 Redirect 된다. 하지만 AWS Route53을 사용한다고 하면, `CNAME flattening` 같은 걸 제공하지 않는다. 따라서 `jayground.com`으로 CNAME record를 등록 할 수가 없다. AWS Route53에서 Root record로 AWS에 있는 resource들을 Alias로 등록할 수는 있지만, 다른 도메인을 등록할 수는 없다.

## 🤔 Webflow는 왜 이렇게 되어 있는 걸까?

`CNAME flattening`의 장점을 생각해보면, Webflow에서 고정된 IP address를 A record로 등록하게 하는 것보다 CNAME을 등록하면 인프라 리소스가 변경되어도 유연하게 대처할 수 있을 것이다. 그런데 기본적으로 `Root record`로 CNAME을 등록할 수가 없으니깐, `jayground.com`에는 A record를 등록할 수 있게 IP address를 제공한다. 그리고 이건 아주 간단하게 Redirect만 수행해서 인프라 자원을 최소한으로 쓰도록 한다. 그리고 redirect된 `www.jayground.com`은 CNAME을 등록할 수 있으니깐, `proxy-ssl.webflow.com`에서 Let's encrypt 인증서도 내려주고, 해당 컨텐츠들을 내려준다. 그런데 만약 `CNAME flattening` 지원한다고 하면 `jayground.com`와 `www.jayground.com` 모두 CNAME으로 등록하여 인프라 자원의 유연함을 가져갈 수 있을 것이다.

## 🤔 Github pages는?

그런데 Webflow 케이스에 대한 나의 생각이 맞다면, Github pages의 경우에 사용하는 사용자 숫자가 훨씬 많을 텐데 왜 CNAME을 활용하지 않을까?🤔 Github pages의 경우에는 모두에게 [문서에 나온 것처럼](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) 특정한 IP를 제공하여 A record를 등록하게 한다.

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

이 IP의 서버들이 load balancer로 reverse proxy 역할을 할 것이고, 이 서버들의 사양이 충분히 대규모 사용자의 트래픽을 충분히 감당할 수 있게 설계가 되어 있을 것이다. 일단 DNS specification에서는 `CNAME record`를 root record로 등록할 수가 없고, `CNAME flattening`같은 건 CNAME을 등록할 수 있는 편법(?)같은 거니깐 `CNAME`은 생각하지 않는 것일까? 그리고 Github pages는 이미 대규모의 사용자를 가지고 있고, 그것을 위해 변화가 적은 인프라를 유지하고 있어서 구지 `CNAME record`를 통해서 유연함을 가져갈 필요가 없는 것일까? 🤔🤔🤔
