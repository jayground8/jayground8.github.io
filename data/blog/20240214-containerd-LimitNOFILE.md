---
title: 'containerd nofile default 설정값'
date: '2024-02-14'
tags: ['kubernetes', 'containerd']
images: ['/static/images/social-banner.png']
summary: 'Kubernetes에서 pod가 실행될 때, 해당 process의 open file 갯수 limit이 어떻게 되는지 궁금하였다. Containerd가 systemd service로 동작하는 상황에서 systemd에서 LimitNOFILE이 inifinity로 설정되어 있는 것을 확인하였다. infinity가 Ubuntu systemd 240 버전 이상에서는 process에 최대로 할당할 수 있는 File 갯수인 fs.nr_open 값으로 설정된다. 실제로 test용 pod를 띄어서 containerd에 의해서 실행되는 process의 nofile limit이 LimitNOFILE에 설정된 값으로 동일하게 설정되는 것을 확인하였다.'
---

## 테스트 환경

- 네이버 클라우드 쿠버네티스 서비스 버전: 1.26
- Containerd 버전: 1.6.16 (2023-01-29 배포)
- systemd 버전: 245.4-4ubuntu3.15
- 커널 버전: 5.4.0-163-generic

## 궁금증

Linux에서 socket도 file descriptor로 관리가 되고, Web server에서 open file 갯수 limit이 작으면 문제가 발생할 수 있다. 그래서 container process의 nofile limit이 어떻게 되는지 궁금하였다.

## Containerd

네이버 클라우드 쿠버네티스 1.26의 경우에 container runtime은 containerd로 설정되어 있다. 그리고 2023년 1월 29일날 배포된 1.6.16 버전이 systemd로 실행된다. 따라서 아래처럼 systemctl 명령으로 systemd service 설정파일을 보면 아래와 같다. 그리고 눈여겨 볼 설정은 `LimitNOFILE`이 `infinity`으로 되어 있다.

```bash
$ systemctl cat containerd

[Unit]
Description=containerd container runtime
Documentation=https://containerd.io
After=network.target local-fs.target

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/bin/containerd

Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNPROC=infinity
LimitCORE=infinity
LimitNOFILE=infinity
TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
```

[LimitNOFILE에 대해서는 containerd.service 설정에서 제거되어야 한다는 이슈](https://github.com/containerd/containerd/pull/8924)가 있다. 해당 이슈에서 아래와 같은 설명이 있다. 현재 테스트하는 환경인 Ubuntu와 systemd version 245에서 infinity로 설정하면 `fs.nr_open` 값 이상으로 설정될 수 없는 것으로 판단이 된다.

> Some distros like Debian with systemd v240+ opt-out via a patch from systemd increasing fs.nr_open beyond the default 1048576 which reduces the concern of using infinity (but you really shouldn't have the soft limit set to infinity).

`fs.nr_open`은 프로세스에 최대로 할당될 수 있는 file 갯수를 나타내는데, 확인을 해보면 `1048576`으로 설정된 것을 확인할 수 있다. 그렇기 때문에 Containerd에 의해서 생성되는 process의 open file 갯수 limit이 이 값으로 설정된다.

```bash
$ sysctl -n fs.nr_open
1048576
```

테스트를 위해서 debug용 pod를 실행한다. 그리고 `ulimit` 명령어로 nofile 설정값을 보면 `1048576`로 되어 있는 것을 확인할 수 있다.

```bash
$ kubectl run -i --tty --rm debug --image=ubuntu --restart=Never -n dev -- sh
# ulimit -n
1048576
```

해당 pod가 실행되고 있는 Worker Node에서 해당 Process를 확인한다.

```bash
$ ps -ef
root     1774314       1  0 15:52 ?        00:00:00 /usr/bin/containerd-shim-runc-v2 -namespace k8s.io -id e627fdc16dde0f0508fa552a96e1958153034b8a0f7f54cd0adc4a3716e96f70 -address /run/containerd/containerd.sock
root     1774385 1774314  0 15:52 pts/0    00:00:00 sh
```

그리고 ubuntu image로 container가 실행되고 있는 processId `1774385`로 확인을 해보면 아래와 같이 max open files이 동일하게 1048576로 설정이 된 것을 확인할 수 있다.

```bash
$ cat /proc/1774385/limits
Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max file size             unlimited            unlimited            bytes
Max data size             unlimited            unlimited            bytes
Max stack size            8388608              unlimited            bytes
Max core file size        unlimited            unlimited            bytes
Max resident set          unlimited            unlimited            bytes
Max processes             unlimited            unlimited            processes
Max open files            1048576              1048576              files
Max locked memory         65536                65536                bytes
Max address space         unlimited            unlimited            bytes
Max file locks            unlimited            unlimited            locks
Max pending signals       31532                31532                signals
Max msgqueue size         819200               819200               bytes
Max nice priority         0                    0
Max realtime priority     0                    0
Max realtime timeout      unlimited            unlimited            us
```

그리고 container process에서 `ulimit`으로 변경하면,

```bash
ulimit -n 10000
```

변경한 값으로 적용된 것이 확인이 된다.

```bash
$ cat /proc/1774385/limits
...
Max open files            10000                10000                files
```

Systemd Containerd service의 `LimitNOFILE` 값을 변경해서 service를 restart를 하면, 새로 뜨는 pod container의 nofile limit이 변경된 값으로 반영이 되는 것을 확인할 수 있다.

```bash
[Unit]
Description=containerd container runtime
Documentation=https://containerd.io
After=network.target local-fs.target

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/bin/containerd

Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNPROC=infinity
LimitCORE=infinity
LimitNOFILE=10000
TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
```

## 결론

Ubuntu에서 `ulimit -Sn`와 `ulimit -Hn`을 보면, soft limit은 1024, hard limit은 1048576로 설정된 것을 확인할 수 있었다. 여기서 soft limit 1024는 server를 운영할 때 socket 연결이 많으면 open file limt때문에 장애가 발생할 수 있다. Kubernetes container runtime을 containerd로 사용하고 있는 상황에서, systemd service로 동작하는 containerd가 `LimitNOFILE` 설정이 적용되어 있다는 것을 알게 되었다. 그리고 운영하는 환경에서 pod로 서버를 운영할 때, soft limit도 1048576로 충분히 크게 잡히는 것을 확인하였다.
