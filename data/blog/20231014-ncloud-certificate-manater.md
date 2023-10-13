---
title: '네이버 클라우드 certificate manager에 Lets encrypt 인증서 등록하기'
date: '2023-10-14'
tags: [ncloud]
images: ['/static/images/social-banner.png']
summary: 'Lets encrypt로 인증서를 발급하여 이것을 Naver Cloud Certificate Manager에 등록하려고 하였다. certbot을 통해서 인증서를 발급받고 해당 파일들을 Certificate manager에 등록하려고 하니 에러가 발생하였다. 이번 블로그 포스팅은 두 가지의 에러를 해결한 삽질기이다.'
---

## Let's Encrypt로 인증서 발급

Ubuntu20.04 네이버 클라우스 서버에서 certbot을 설치하여 Let's encrypt 인증서를 발급하였다. Ubuntu 20.04에서 설치하는 것은 [이 글](https://www.digitalocean.com/community/tutorials/how-to-use-certbot-standalone-mode-to-retrieve-let-s-encrypt-ssl-certificates-on-ubuntu-20-04)을 참고하였다.

```bash
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
```

```bash
$ certbot --version
certbot 2.7.1
```

이제 아래와 같이 dns로 check하도록 설정하여 인증서를 발급하였다.

```bash
certbot certonly --manual -d *.example.com -d example.com --preferred-challenges dns-01
```

TXT record를 안내에 따라서 생성해주면 검증이 완료되어서 인증서 발급이 완료가 된다. `/etc/letsencrypt/live/example.com`에서 아래와 같이 생성된 것을 확인할 수 있다.

- cert.pem
- chain.pem
- fullchain.pem
- privkey.pem

## 인증서 암호화 알고리즘 검증 실패입니다.

이제 발급된 인증서 정보를 네이버 클라우드 certificate manager에 등록하는데 아래와 같은 에러가 발생하였다.

<img src="/static/images/ncloud-certificate-manager-error.png" alt="error to register certificate on naver cloud" />

`openssl`로 인증서 정보를 확인해보면,

```bash
openssl x509 -in cert.pem -text -noout
```

아래와 같이 `id-ecPublicKey`로 설정되어 있는 것을 확인할 수 있다.

```bash
Subject Public Key Info:
  Public Key Algorithm: id-ecPublicKey
      Public-Key: (256 bit)
      pub:
```

[Let's encrypt의 certificate](https://letsencrypt.org/certificates/)를 확인해보면

```bash
openssl x509 -in lets-encrypt-r3.pem -text -noout
```

아래처럼 RSA로 되어 있는 것을 확인할 수 있다.

```bash
Subject Public Key Info:
  Public Key Algorithm: rsaEncryption
```

따라서 이것을 동일하게 맞춰주기 위해서 `--key-type`을 RSA를 해준다.

```bash
certbot certonly --manual -d *.example.com -d example.com \
  --preferred-challenges dns-01 \
  --key-type rsa
```

이제 해당 에러는 해결이 된다.

## 인증서가 유효하지 않습니다.

이제 앞의 에러는 해결했는데, `인증서가 유효하지 않습니다`라고 에러가 발생하면서 등록이 되지 않는다. 🤪

이제 chain을 보면 마지막에 CA 부분인데, 그 부분만 따로 인증서 정보를 확인해보니

```bash
openssl x509 -in ca_from_chain.pem -text -noout
```

Issuer가 `DST Root CA X3`으로 되어 있는 것을 확인할 수 있었다.

```bash
Issuer: O = Digital Signature Trust Co., CN = DST Root CA X3
Validity
  Not Before: Jan 20 19:14:03 2021 GMT
  Not After : Sep 30 18:14:03 2024 GMT
Subject: C = US, O = Internet Security Research Group, CN = ISRG Root X1

```

[let's encrypt 글](https://letsencrypt.org/2023/07/10/cross-sign-expiration.html)을 보면 `DST Root CA X3`은 old version을 위해서 유지되고 있다. 5년 전부터 `ISRG Root X1`를 사용하고 있었고, `DST Root CA X3`에서도 사용할 수 있고 cross-signing으로 되어 있기 때문에 위에서처럼 마지막 certificate의 Issuer가 `DST Root CA X3`로 되어 있다.

- website certicate
- Let’s Encrypt R3
- ISRG Root X1
- DST Root CA X3

이제 네이버 클라우드 Certificate manager에서는 CA certificate를 추가해줘야하는 것으로 보인다. 따라서 [Let's encrypt의 certificate](https://letsencrypt.org/certificates/)에서 아래 그림과 같이 Root certificate를 다운로드해서 `fullchain.pem`에 추가해줬다.

<img src="/static/images/ncloud-certificate-manager-ca-cert.png" alt="ca certificate from lets encrypt web page" />

하지만 생성된 `fullchain.pem`이 DST Root CA X3로 cross-signing으로 되어 있기 때문에, 네이버 클라우드 Certificate Manager에 올리면 `인증서가 유효하지 않습니다`라는 에러가 발생하였다. 그래서 chain의 마지막 Root CA 인증서를 추가하지 않고, 교체했다.

- website certicate
- Let’s Encrypt R3
- ISRG Root X1
- DST Root CA X3 => Root CA 인증서로 교체

이제 정상적으로 등록이 된다.

## 기타

### Ubuntu CA trust store

위에서 certbot을 셋팅해서 사용한 ubuntu20.04 서버에서 CA trust store에 저장되어 있는 걸 보면

```bash
awk -v cmd='openssl x509 -noout -subject' '
    /BEGIN/{close(cmd)};{print | cmd}' < /etc/ssl/certs/ca-certificates.crt
```

아래처럼 `ISRG Root X1`가 보인다.

```bash
subject=C = US, O = Internet Security Research Group, CN = ISRG Root X1
```

### --preferred-chain Option

🤔 certbot 명령어로 cross-signing이 아니라 `ISRG Root X1`를 사용하도록 설정하는 방법이 없나? `--preferred-chain 'SRG Root X1'`은 Intemediate certificate가 생성되지 않는다.
