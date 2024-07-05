---
title: 'OpenTelmetry로 auth.log와 syslog 수집하기'
date: '2024-05-01'
tags: ['kubernetes', 'opentelemetry', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'Ubuntu 20.04 서버의 auth.log, syslog 로그 값들을 OpenTelemetry를 통해서 수집하고 싶었다. 처음에는 Filelog Receiver를 통해서 수집하려고 하였고, rsyslog의 설정값을 변경하여 Filelog로 수집하도록 구성했다. 그런데 이후에 Syslog Receiver가 존재하는 것을 확인하게 되었고, 훨씬 간단하게 syslog를 수집할 수 있었다.'
---

[OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/README.md)를 사용해서 Ubuntu 서버의 `/var/log/auth.log`와 `/var/log/syslog`를 수집하고 싶었다.

환경

- Ubuntu 20.04
- `opentelemetry-collector ` Chart version `0.90.0`

## Filelog Receiver

[Filelog Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/filelogreceiver)로 log file을 tail하고 parse를 할 수 있다. 따라서 `audit.log`, `syslog` 파일들을 filelog로 수집하면 되겠다는 생각을 하였다. 따라서 아래와 같이 value값을 설정하여 Helm으로 배포하였다.

`values.yaml`

```yaml
config:
	receivers:
		jaeger: null
		prometheus: null
		zipkin: null
		filelog:
			exclude: []
			include:
			- /var/log/auth.log
			- /var/log/syslog
			include_file_name: false
			include_file_path: true
			operators:
			- id: parser-host-log
				regex: ^(?P<time>^[^ Z]+) (?P<hostname>[^ ]*) (((?P<service>[^ ]*)\[(?P<pid>.*)\]|(?P<command>[^ ]*)):) (?P<message>.*)$
				timestamp:
					layout: 2006-01-02T15:04:05.999999999Z07:00
					layout_type: gotime
					parse_from: attributes.time
				type: regex_parser
			- type: add
				field: attributes.container
				value: host
			poll_interval: 5s
			start_at: end
	service:
		telemetry:
			logs:
				level: info
		pipelines:
			traces:
				receivers:
					- otlp
			metrics:
				receivers:
					- otlp
			logs:
				receivers:
					- filelog
				exporters:
					- debug
	exporters:
		debug:
			verbosity: detailed
ports:
	jaeger-compact:
		enabled: false
	jaeger-thrift:
		enabled: false
	jaeger-grpc:
		enabled: false
	zipkin:
		enabled: false
mode: daemonset
image:
	repository: otel/opentelemetry-collector-k8s
extraVolumeMounts:
- mountPath: /var/log/
	name: varlog
	readOnly: true
extraVolumes:
- hostPath:
		path: /var/log/
	name: varlog
presets:
	logsCollection:
		enabled: true
		includeCollectorLogs: true
```

[opentelmetry-collector Chart template](https://github.com/open-telemetry/opentelemetry-helm-charts/blob/opentelemetry-collector-0.90.1/charts/opentelemetry-collector/templates/_pod.tpl)를 보면, `logsCollection.enabled`이 true로 설정했을 때 아래와 같이 hostPath가 추가되는 것을 알 수 있다.

```yaml
# VolumeMounts
{{- if .Values.presets.logsCollection.enabled }}
- name: varlogpods
	mountPath: /var/log/pods
	readOnly: true
- name: varlibdockercontainers
	mountPath: /var/lib/docker/containers
	readOnly: true
{{- if .Values.presets.logsCollection.storeCheckpoints}}
- name: varlibotelcol
	mountPath: /var/lib/otelcol
{{- end }}
{{- end }}

# Volumes
{{- if .Values.presets.logsCollection.enabled }}
- name: varlogpods
	hostPath:
		path: /var/log/pods
{{- if .Values.presets.logsCollection.storeCheckpoints}}
- name: varlibotelcol
	hostPath:
		path: /var/lib/otelcol
		type: DirectoryOrCreate
{{- end }}
- name: varlibdockercontainers
	hostPath:
		path: /var/lib/docker/containers
{{- end }}
```

Host의 `/var/log` 아래에 있는 `auth.log`와 `syslog`를 접근하기 위해서는 hostPath를 추가해줘야 한다. 따라서 Helm values에 아래와 같이 추가한다.

```yaml
extraVolumeMounts:
- mountPath: /var/log/
	name: varlog
	readOnly: true
extraVolumes:
- hostPath:
		path: /var/log/
	name: varlog
```

그런데 Ubuntu server에서 실행되는 rsyslog가 남기는 파일 권한이 640으로 되어있다. 따라서 hostPath를 사용해도 파일들을 읽을 권한이 없어서 에러가 발생한다. 따라서 opentelemetry collector agent에 에러 로그가 남는 것을 확인할 수 있다. rsyslog가 파일을 생성할 때, `rsyslog.conf`의 `$FileCreateMode`을 수정하여 644로 조정하였다.

`/etc/rsyslog.conf`

```bash
#
# Set the default permissions for all log files.
#
$FileOwner syslog
$FileGroup adm
$FileCreateMode 0644 # 640에서 변경
$DirCreateMode 0755
$Umask 0022
$PrivDropToUser syslog
$PrivDropToGroup syslog
```

rsyslog를 재시작하고 나면 이제 새로 만들어지는 파일에 대해서 변경된 권한이 적용된다. 이렇게 변경된 권한의 파일을 opentelemetry collector agent가 정상적으로 읽을 수 있게 된다.

```bash
systemctl daemon-reload
systemctl restart rsyslog
```

그리고 log message의 format을 보면 아래와 같이 기본 설정이 되어 있었다.

```log
May  1 20:33:04 hostname sshd[2692917]: pam_tally2(sshd:setcred): unknown option: reset
```

`May 1 20:33:04` 값이 연도 숫자가 없고, Filelog의 operator를 통해서 parse하는데도 어려움이 있었다. `syslog.conf`를 확인하면 아래와 같이 [rsyslog에서 기본적으로 제공하는 template](https://www.rsyslog.com/doc/configuration/templates.html)중에 하나가 선택되어 있다.

`/etc/rsyslog.conf`

```bash
$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat
```

날짜형식을 `rfc3339`으로 하는 template을 아래와 같이 설정하고, rsyslog를 다시 재시작한다.

```bash
$ActionFileDefaultTemplate RSYSLOG_FileFormat
```

변경이 적용되면 아래와 같이 log message가 남게 된다.

```log
2024-05-01T23:04:35.590363+09:00 hostname systemd: pam_tally2(systemd-user:setcred): unknown option: reset
```

그래서 이제 `regex_parser`를 통해서 log message를 정규표현식에 맞춰서 parse한다. time group값을 통해서 timestamp를 생성한다. [gotime과 strptime type이 있고 layout은 이 문서를 확인해서 작성한다.](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/docs/types/timestamp.md)

```yaml
- id: parser-host-log
	regex: ^(?P<time>^[^ Z]+) (?P<hostname>[^ ]*) (((?P<service>[^ ]*)\[(?P<pid>.*)\]|(?P<command>[^ ]*)):) (?P<message>.*)$
	timestamp:
		layout: 2006-01-02T15:04:05.999999999Z07:00
		layout_type: gotime
		parse_from: attributes.time
	type: regex_parser
```

debug exporter를 설정하여 standout으로 출력되는 값을 확인해본다.

```yaml
exporters:
	debug:
		verbosity: detailed
```

이제 정상적으로 아래와 같이 opentelmetry collector agent에 로그가 남는다.

```bash
kubectl logs -f -l component=agent-collector
```

```bash
LogRecord #6
ObservedTimestamp: 2024-05-01 15:12:16.671281334 +0000 UTC
Timestamp: 2024-05-01 15:12:14.30976 +0000 UTC
SeverityText:
SeverityNumber: Unspecified(0)
Body: Str(2024-05-02T00:12:14.309760+09:00 hostname sshd[2727770]: pam_tally2(sshd:setcred): unknown option: reset)
Attributes:
     -> command: Str()
     -> message: Str(pam_tally2(sshd:setcred): unknown option: reset)
     -> container: Str(host)
     -> log.file.path: Str(/var/log/auth.log)
     -> time: Str(2024-05-02T00:12:14.309760+09:00)
     -> hostname: Str(hostname)
     -> service: Str(sshd)
     -> pid: Str(2727770)
Trace ID:
Span ID:
Flags: 0
	{"kind": "exporter", "data_type": "logs", "name": "debug"}
```

## Syslog Receiver

그런데 Receiver 종류를 보다가 [Syslog Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/syslogreceiver/README.md)도 있는 것을 알게 되었다. 그리고 [rsyslog 모듈인 omfwd](https://www.rsyslog.com/doc/configuration/modules/omfwd.html)를 통해서 rsyslog가 opentelemetry syslog receiver에 로그를 보낼 수 있는 것을 알게 되었다. [SigNoz의 문서에서 rsyslog 설정하는 방법을 잘 설명](https://signoz.io/docs/userguide/collecting_syslogs/)하고 있다.

이번에는 아래와 같이 `values.yaml`을 작성하고 Helm Chart를 배포한다.

`values.yaml`

```yaml
config:
	receivers:
		jaeger: null
		prometheus: null
		zipkin: null
		syslog:
			tcp:
				listen_address: "localhost:4319"
			protocol: rfc3164
			location: UTC
			operators:
				- type: move
					from: attributes.message
					to: body
				- type: add
                  field: attributes.source
                  value: syslog
	service:
		telemetry:
			logs:
				level: info
		pipelines:
			traces:
				receivers:
					- otlp
			metrics:
				receivers:
					- otlp
			logs:
				receivers:
					- syslog
				exporters:
					- debug
	exporters:
		debug:
			verbosity: detailed
ports:
	jaeger-compact:
		enabled: false
	jaeger-thrift:
		enabled: false
	jaeger-grpc:
		enabled: false
	zipkin:
		enabled: false
	syslog:
		enabled: true
		containerPort: 4319
		hostPort: 4319
		protocol: TCP
mode: daemonset
image:
	repository: otel/opentelemetry-collector-contrib
hostNetwork: true
presets:
	logsCollection:
		enabled: false
		includeCollectorLogs: true
```

`syslog receiver`를 사용하기 위해서 `image.repository`를 `otel/opentelemetry-collector-contrib`로 설정하였다. 그리고 `listen_address`를 `0.0.0.0:4319`로 설정했는데, rsyslog가 host에서 해당 `4319` 포트로 접근할 수 있도록 `hostPort`를 사용하도록 설정하였다.

`hostPort`를 설정하였기 때문에, opentelemetry collector의 설정을 보면 `4319/TCP`가 설정된 것을 확인할 수 있다.

```bash
$ kubectl describe pod opentelemetry-collector-agent-b7g2j
...생략
Ports:         4317/TCP, 4318/TCP, 4319/TCP
Host Ports:    4317/TCP, 4318/TCP, 4319/TCP
```

그리고 Cilium을 CNI로 사용할 때, 아래와 같이 service의 목록을 보면 HostPort가 설정된 것을 확인할 수 있다.

```bash
$ kubectl exec -it cilium-gxdr7 -n kube-system -- cilium service list
...생략
196   10.50.3.14:4317         HostPort       1 => 198.18.4.92:4317 (active)
197   0.0.0.0:4317           HostPort       1 => 198.18.4.92:4317 (active)
198   10.50.3.14:4318         HostPort       1 => 198.18.4.92:4318 (active)
199   0.0.0.0:4318           HostPort       1 => 198.18.4.92:4318 (active)
200   10.50.3.14:4319        HostPort       1 => 198.18.4.92:4319 (active)
201   0.0.0.0:4319          HostPort       1 => 198.18.4.92:4319 (active)
```

이제 [SigNoz의 문서에서 rsyslog 설정하는 방법](https://signoz.io/docs/userguide/collecting_syslogs/)에 나온 것처럼 rsyslog 설정을 아래와 같이 추가한다.

`/etc/rsyslog.conf`

```bash
template(
  name="UTCTraditionalForwardFormat"
  type="string"
  string="<%PRI%>%TIMESTAMP:::date-utc% %HOSTNAME% %syslogtag:1:32%%msg:::sp-if-no-1st-sp%%msg%"
)

*.* action(type="omfwd" target="127.0.0.1" port="4319" protocol="tcp" template="UTCTraditionalForwardFormat")
```

이제 rsyslog를 재시작하고 나면 Syslog Receiver로 로그를 받은 것을 확인할 수 있다.

```bash
2024-05-01T15:01:34.346Z	info	ResourceLog #0
Resource SchemaURL:
ScopeLogs #0
ScopeLogs SchemaURL:
InstrumentationScope
LogRecord #0
ObservedTimestamp: 2024-05-01 15:01:34.219612783 +0000 UTC
Timestamp: 2024-05-01 15:01:34 +0000 UTC
SeverityText: err
SeverityNumber: Error(17)
Body: Str(pam_tally2(sshd:setcred): unknown option: reset)
Attributes:
     -> priority: Int(83)
     -> facility: Int(10)
     -> hostname: Str(hostname)
     -> appname: Str(sshd)
     -> proc_id: Str(2725522)
Trace ID:
Span ID:
Flags: 0
	{"kind": "exporter", "data_type": "logs", "name": "debug"}
```

## 결론

OpenTelmetry에서 Syslog Receiver가 Alpha 상태로 제공되고 있다. rsyslog에서 omfwd 모듈을 통해서 syslog message를 Syslog Receiver로 보낼수가 있다. 그렇게 하기 위해서 rsyslog.conf 설정값을 변경하여 rsyslog를 재시작해야 한다. 처음에는 Syslog Receiver로 쉽게 받을 수 있는 것을 생각하지 못하고, Filelog를 통해서 받도록 설정하였다. 이 과정에서 rsyslog가 file을 생성할 때 644로 권한설정하도록 설정하고, opentelemetry collector agent가 hostPath를 통해서 /var/log에 접근하도록 하였다. 하지만 이 과정에서 Regex rule을 올바르게 작성하는데 어려움이 있었고, 잘못된 설정들로 인해서 최종적으로 원하는 동작을 확인하기까지 시간이 꽤 걸렸다.🥺
