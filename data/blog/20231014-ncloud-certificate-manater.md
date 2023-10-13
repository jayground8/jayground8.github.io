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

이제 해당 암호는 해결이 된다.

## 인증서가 유효하지 않습니다.

이제 앞의 에러는 해결했는데, `인증서가 유효하지 않습니다`라고 에러가 발생하면서 등록이 되지 않는다. 🤪

이제 chain을 보면 마지막에 CA 부분인데, 그 부분만 따로 인증서 정보를 확인해보니

```bash
openssl x509 -in ca_from_chain.pem -text -noout
```

Issuer가 `DST Root CA X3`으로 되어 있는 것을 확인할 수 있었다. [let's encrypt 글](https://letsencrypt.org/2023/07/10/cross-sign-expiration.html)을 보면 `DST Root CA X3`은 old version을 위해서 유지하고 있다.

```bash
Issuer: O = Digital Signature Trust Co., CN = DST Root CA X3
```

Certificate Manager에서 해당 CA certificate으로 올릴 때는 `인증서가 유효하지 않습니다`라는 에러가 발생하였다. 그래서 chain의 마지막 Root CA 인증서를 아래와 같이 [Let's encrypt의 certificate](https://letsencrypt.org/certificates/)에서 가져와서 바꿔준다.

<img src="/static/images/ncloud-certificate-manager-ca-cert.png" alt="ca certificate from lets encrypt web page" />

이제 정상적으로 등록이 된다.
