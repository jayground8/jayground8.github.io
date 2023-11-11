---
title: 'CVE 취약점 확인하고 Ubuntu Kernel Update 해보기'
date: '2023-11-11'
tags: [ubuntu, security]
images: ['/static/images/social-banner.png']
summary: 'OpenSCAP으로 Ubuntu20.04 이미지를 사용하는 가상서버의 취약점 리포트를 만들어보고, 보고된 취약점이 패치된 커널 버전으로 업그레이드 하여 해당 이슈를 해결해보았다. 이렇게 업그레이드 된 커널과 패키지들이 정상적으로 작동하는지 확인하고 사용할 수 있는 파이프라인을 만드는 것도 나중에 고민해봐야겠다.'
---

## OpenSCAP으로 취약점을 확인

네이버 클라우드의 Ubuntu 서버의 취약점을 확인하고 싶어서 [해당 글](https://www.server-world.info/en/note?os=Ubuntu_22.04&p=openscap&f=1)을 보고 report를 만들어봤다. `Ubuntu20.04`를 테스트하였기 때문에 code name `focal`로 `OVAL`을 받았다. `OVAL(Open Vulnerability and Accessment Language)`는 보안 내용을 공유할 수 있도록 표준을 제시하고 xml format으로 제공된다.

```bash
sudo apt -y install libopenscap8 bzip2
wget https://security-metadata.canonical.com/oval/com.ubuntu.$(lsb_release -cs).usn.oval.xml.bz2
bzip2 -d com.ubuntu.focal.usn.oval.xml.bz2
```

그리고 이제 다운로드한 xml을 바탕으로 report를 생성한다.

```bash
oscap oval eval --report report.html com.ubuntu.focal.usn.oval.xml
```

만들어진 html 형식의 report를 열어 보니 `USN-6441-1 -- Linux kernel vulnerabilities` 취약점이 보고가 되었다.

<img src="/static/images/cve-report-red.png" alt="cve report" />

`USN` prefix는 Ubuntu Security Notice로 [Ubuntu Oval data](https://ubuntu.com/security/oval)를 확인할 수 있다. 해당 `USN-6441-1`로 확인을 하면 [이 링크](https://ubuntu.com/security/notices/USN-6441-1)처럼 정보를 제공한다. 해당 문서를 확인하면 아래처럼 어떤 Ubuntu kernel version에서 해당 이슈가 patch되었는지 알 수가 있다.

<img src="/static/images/linux-kernel-versions.png" alt="ubuntu kernel version list" />

그리고 아래의 그림처럼 어떠한 CVE 취약점들이 해결되었는지도 확인이 가능하다. OpenSCAP으로 리포트를 만들었을 때도 해당 CVE id들이 같이 보인다.

<img src="/static/images/cve-id-list.png" alt="cve references" />

테스트한 Ubuntu의 kernel은 `5.4.0-148-generic`이고, 해당 취약점을 patch하기 위해서 `5.4.0-165-generic`으로 update해야 한다.

```bash
$ uname -r
5.4.0-148-generic
```

## Kernel upgrade

Ubuntu kernel을 네이버 클라우드에서 업데이트 하는 방법은 [네이버 클라우드 문서](https://guide.ncloud-docs.com/docs/ubuntu20-kernel-update)에 친절하게 설명이 되어 있다. Ubuntu에서는 `linux-image-*` 패키지를 통해서 새로운 kernel version을 설치할 수 있다. 설치할 수 있는 package들을 아래처럼 확인해본다.

```bash
$ apt-get update
$ apt-cache search linux-image-5.4.0-*
```

`/etc/apt/sources.list`를 확인해보면 source들이 Naver Cloud url로 되어 있는 것을 확인할 수 있다. 해당 source로는 `linux-image-5.4.0-159-generic`가 가장 최신 버전의 package였다. 따라서 `/etc/apt/sources.list`에 아래 source들을 추가하였다.

```bash
deb http://archive.ubuntu.com/ubuntu/ focal main restricted universe multiverse
deb-src http://archive.ubuntu.com/ubuntu/ focal main restricted universe multiverse

deb http://archive.ubuntu.com/ubuntu/ focal-updates main restricted universe multiverse
deb-src http://archive.ubuntu.com/ubuntu/ focal-updates main restricted universe multiverse

deb http://archive.ubuntu.com/ubuntu/ focal-security main restricted universe multiverse
deb-src http://archive.ubuntu.com/ubuntu/ focal-security main restricted universe multiverse

deb http://archive.ubuntu.com/ubuntu/ focal-backports main restricted universe multiverse
deb-src http://archive.ubuntu.com/ubuntu/ focal-backports main restricted universe multiverse

deb http://archive.canonical.com/ubuntu focal partner
deb-src http://archive.canonical.com/ubuntu focal partner
```

이제 `linux-image-5.4.0-165-generic` package도 리스트에 있는게 확인된다. 해당 package를 설치하고 reboot을 한다.

```bash
$ apt-get update
$ apt install linux-image-5.4.0-165-generic
$ reboot
```

reboot이 완료되고 나면, 아래처럼 `5.4.0-165-generic`인 것을 확인할 수 있다.

```bash
$ uname -r
5.4.0-165-generic
```

이제 다시 취약점을 검사하고 report를 생성해본다.

```bash
oscap oval eval --report report2.html com.ubuntu.focal.usn.oval.xml
```

이제 해당 취약점이 해결된 것을 확인할 수 있다.

<img src="/static/images/cve-report-green.png" alt="cve report" />

## Golden AMI pipeline

CVE 취약점을 확인하였고, 해당 취약점에 patch가 적용되도록 kernel을 업그레이드하였다. 문제는 해당 kernel이 해당 클라우드 벤더 가상서버에서 테스트가 완료되지 않았다. 해당 Kernel version이 가상서버에서 문제없이 잘 작동하는지는 사용자가 테스트를 해야 한다. 따라서 예전에 봤던 [AWS Golden AMI pipeline에 대한 블로그](https://aws.amazon.com/blogs/awsmarketplace/announcing-the-golden-ami-pipeline/)가 떠올랐다. 네이버 클라우드에서는 이러한 파이프라인을 어떻게 구성할 수 있을까? 🤔🤔
