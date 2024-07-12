---
title: 'Vault Audit Log를 남기기'
date: '2024-07-13'
tags: ['vault', 'devsecops']
images: ['/static/images/social-banner.png']
summary: 'Vault에서 다양한 credentials를 보관하게 된다. 따라서 어떤 접근들이 있었는지 Audit Log들을 남겨서 관리하고 싶었다. Vault에서 Audit Device 기능을 제공하여서 file, syslog, socket등으로 Vault API 요청과 응답을 로그로 남길 수 있다. socket은 log 손실의 위험이 있고, syslog는 Vault Pod에서 추가적인 package설치와 설정이 필요하다. 따라서 Kubernetes에서 Vault를 운영하는 과정에서 file 방식으로 Audit log를 남겨보았다.'
---

이번에는 Kubernetes에서 Vault를 운영할 때 Audit log를 남기는 방법을 알아본다. Vault에서 Audit 기능을 제공하여 API 요청과 응답을 Log로 남길 수 있다. [Vault 공식 문서](https://developer.hashicorp.com/vault/docs/audit)에서 친절하게 설명하고 있다.

## File audit device 사용

[Vault를 Helm Chart](https://github.com/hashicorp/vault-helm/blob/main/values.yaml)로 설치할 때, `auditStorage`의 `enabled`를 true로 설정하면 PVC가 생성된다. 그리고 mount path는 `/vault/audit`이 된다.

```yaml
auditStorage:
	enabled: false
	# Size of the PVC created
	size: 10Gi
	# Location where the PVC will be mounted.
	mountPath: "/vault/audit"
	# Name of the storage class to use.  If null it will use the
	# configured default Storage Class.
	storageClass: null
	# Access Mode of the storage device being used for the PVC
	accessMode: ReadWriteOnce
	# Annotations to apply to the PVC
	annotations: {}
	# Labels to apply to the PVC
	labels: {}
```

vault에서 audit 기능을 사용하도록 CLI로 설정할 때 `file_path`를 설정하게 된다. 위에서 mount된 volume의 path로 설정한다.

```bash
vault audit enable -path="vault_audit" file file_path=/vault/audit/audit.log
```

audit list 명령어로 정상적으로 등록되면 아래처럼 audit device 목록을 볼 수 있다.

```bash
$ vault audit list
Path              Type    Description
----              ----    -----------
vault_audit/    file    n/a
```

[Vault를 Helm Chart](https://github.com/hashicorp/vault-helm/blob/main/values.yaml)에서 기본적으로 `dataStorage`의 `enabled`가 true로 설정되어 있기 때문에, PVC가 생성되고 Volume이 `/vault/data` 경로에 마운팅 된다.

```yaml
dataStorage:
	enabled: true
	# Size of the PVC created
	size: 10Gi
	# Location where the PVC will be mounted.
	mountPath: "/vault/data"
	# Name of the storage class to use.  If null it will use the
	# configured default Storage Class.
	storageClass: null
	# Access Mode of the storage device being used for the PVC
	accessMode: ReadWriteOnce
	# Annotations to apply to the PVC
	annotations: {}
	# Labels to apply to the PVC
	labels: {}
```

그리고 Vault의 High Availability 설정을 하고, storage를 `raft`로 설정하면 Vault Node들이 Raft를 통해서 data들이 복제된다. Raft을 통해서 data가 각 Vault Node들에 저장되는 경로를 위에서 마운팅 된 Volume 경로인 `/vault/data`로 설정한다.

```yaml
ha:
	enabled: true
	replicas: 3
	raft:
		enabled: true
		setNodeId: true

		config: |
			...생략
			storage "raft" {
				path = "/vault/data"
			}
```

이렇게 `replica`가 `3`으로 설정되었기 때문에 아래의 명령어로 확인하면 세 개의 Node가 목록에 나오는 것을 확인할 수 있다.

```bash
$ vault operator raft list-peers
Node       Address                        State       Voter
----       -------                        -----       -----
vault-0    vault-0.vault-internal:8201    follower    true
vault-1    vault-1.vault-internal:8201    leader      true
vault-2    vault-2.vault-internal:8201    follower    true
```

Vault Leader Node가 요청을 처리하기 때문에, 위에서 leader 역할의 vault-1 Node에 audit log가 저장된다. vault-1 container에 접속하여 파일을 확인해본다.

```bash
kubectl exec -it vault-1 -- /bin/sh
```

```bash
$ ls /vault/audit/
audit.log
```

Vault에서 secret 정보들을 가져오면 `audit.log`에 아래와 같은 log가 남은 것을 확인할 수 있다. Log에 남는 비밀 정보의 경우에는 hmac으로 hash 처리되어 있다. (hash값은 [/sys/audit-hash](https://developer.hashicorp.com/vault/api-docs/system/audit-hash) API를 사용해서 처리가 되고, audit device를 새로 생성하면 새로운 salt가 생성된다.) 그리고 vault 인증 방법을 userpass로 했기 때문에 어떤 username으로 접근을 했는지도 Log를 통해서 확인할 수 있다.

```json
{
  "time": "2024-07-12T23:53:50.294066904Z",
  "type": "response",
  "auth": {
    "client_token": "hmac-sha256:936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af",
    "accessor": "hmac-sha256:bb136af09813f2b2ac32f44a32379d5e66ec62022f4d9f557fdc606f8e35b996",
    "display_name": "userpass-myuser",
    "policies": ["default", "example"],
    "token_policies": ["default", "example"],
    "policy_results": {
      "allowed": true,
      "granting_policies": [
        {
          "name": "example",
          "namespace_id": "root",
          "type": "acl"
        }
      ]
    },
    "metadata": {
      "username": "myuser"
    },
    "entity_id": "a9fe7d93-2312-38cf-fw83-5e4a1a9c86c8",
    "token_type": "service",
    "token_ttl": 2764800,
    "token_issue_time": "2024-07-12T23:16:30Z"
  },
  "request": {
    "id": "cf25e9c9-5e9d-edf6-2b7k-61e9d48d5caa",
    "client_id": "a9fe7d93-2312-38cf-fw83-5e4a1a9c86c8",
    "operation": "read",
    "mount_point": "sample/",
    "mount_type": "kv",
    "mount_accessor": "kv_0d071af0",
    "mount_running_version": "v0.16.1+builtin",
    "mount_class": "secret",
    "client_token": "hmac-sha256:936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af",
    "client_token_accessor": "hmac-sha256:bb136af09813f2b2ac32f44a32379d5e66ec62022f4d9f557fdc606f8e35b996",
    "namespace": {
      "id": "root"
    },
    "path": "sample/data/hello",
    "remote_address": "10.70.7.27",
    "remote_port": 40766
  },
  "response": {
    "mount_point": "sample/",
    "mount_type": "kv",
    "mount_accessor": "kv_0d071af0",
    "mount_running_plugin_version": "v0.16.1+builtin",
    "mount_class": "secret",
    "data": {
      "data": {
        "DUMMY": "hmac-sha256:77c825c1329848f7ff467567365b15e027be7bcf720d9d1db86a6e4b0187a4a5"
      },
      "metadata": {
        "created_time": "hmac-sha256:a1aabe17c371bc59be05e18a7e494078d8ba93aa41346ef3cd07d68c47e7a66d",
        "custom_metadata": null,
        "deletion_time": "hmac-sha256:764d7c9b6d83d95578dc1f839a386bfee7ad74e8cf5ca19255aa123aa8d63d2f",
        "destroyed": false,
        "version": 8
      }
    }
  }
}
```

## Container에서 audit log 수집

Vault File Audit Device를 통해서 audit log를 파일로 저장할 수 있는 것을 확인하였다. PVC를 통해서 별도의 Storage에 해당 log를 저장하기 때문에, 해당 Storage를 주기적으로 Snapshot하여 보관할 수 있다. 하지만 이렇게 구성했을 때 audit log를 종합적으로 관리하고 검색하는 것이 어렵다.

Kubernetes에서 운영하고 있기 때문에 Pod의 stdout, stderr로 보내는 로그들을 다양한 Log 수집 Tool을 통해서 쉽게 수집하고 검색할 수 있다. 따라서 Vault audit log를 file로 저장하지 않고 바로 stdout으로 설정하면 이러한 문제를 해결할 수 있다. `file_path` 설정값을 `stdout`으로만 바꾸면 된다.

```bash
vault audit enable -path="vault_audit_stdout" file file_path=stdout
```

## 결론

다행히 Vault Opensource 버전에서 Audit Log를 남길수 있는 기능을 제공한다. Audit Device로 file, syslog, socket등을 제공한다. Socket은 log 손실 가능성이 있고, syslog는 Vault Pod에서 추가적인 패키지 설치와 설정이 필요하다. 따라서 file로 audit log를 남기는 것을 선택하였다. 그리고 실제로 audit.log 파일로 남길때 disk 용량이 꽉차게 되면 Vault 장애를 가져오게 된다. Vault에서 log rotation은 제공하지 않기 때문에 별도의 tool을 통해서 설정을 해야 한다. Kubernetes에서 Vault를 운영중한다면 Log를 수집하고 검색하는 도구들이 이미 갖춰있을 가능성이 높다. 따라서 Vault audit log를 stdout으로 남겨서 이러한 도구들이 수집하고 종합적으로 관리하는 방식으로 진행할 수 있다.
