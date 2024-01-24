---
title: 'Cert Manager Webhook 작성하여 Naver Cloud에서 DNS-01 challeng로 Lets Encrypt 인증서 발급하기'
date: '2024-01-24'
tags: ['kubernetes', 'ncloud']
images: ['/static/images/social-banner.png']
summary: 'Cert Manager의 DNS provider 목록에 Naver Cloud DNS는 없었다. 하지만 Cert Manager에서 새로운 DNS provider를 직접 연결해서 사용할 수 있도록 webhook solver라는 것을 제공한다. 따라서 Naver Cloud API를 사용하여 webhook 코드를 작성하고, Github Action을 통해서 Image와 Helm chart를 배포해서 사용했다. Cert Manager에서 Boilerplate code와 test framework를 제공하여 비교적 쉽게 작성해서 사용할 수 있었다.'
---

## DNS-01

Kubernetes에서 [Cert Manager](https://cert-manager.io/)로 Let's Encrypt Certificate를 쉽게 발급하고 관리할 수 있다. DNS에 TXT Record를 등록하여 확인하는 DNS-01 challenge를 사용하기 위해서는 DNS Provider가 필요하다. Cert Manager의 코드베이스에서 관리되는 DNS01 provider는 아래와 같다. AWS, GCP, Azure와 같은 Cloud에서 사용할 수 있는 DNS provider들은 있으나, 네이버 클라우드에서 사용할 수 있는 provider는 보이지 않았다.

Supported DNS01 providers

- ACMEDNS
- Akamai
- AzureDNS
- CloudFlare
- Google
- Route53
- DigitalOcean
- RFC2136

하지만 Cert Manager는 [Webhook](https://cert-manager.io/docs/configuration/acme/dns01/webhook/)으로 직접 작성해서 사용할 수 있는 방법을 제공한다. 그리고 [Boilerplate 코드](https://github.com/cert-manager/webhook-example)도 제공하고 있어서, Webhook의 구조를 자세히 몰라도 쉽게 작성할 수 있다. Github 리포에서 아래와 같이 설명해주고 있다.

> As the project & adoption has grown, there has been an influx of DNS provider pull requests to our core codebase. As this number has grown, the test matrix has become un-maintainable and so, it's not possible for us to certify that providers work to a sufficient level.
>
> By creating this 'interface' between cert-manager and DNS providers, we allow users to quickly iterate and test out new integrations, and then packaging those up themselves as 'extensions' to cert-manager.
>
> We can also then provide a standardised 'testing framework', or set of conformance tests, which allow us to validate the a DNS provider works as expected.

[Github topic으로 이미 누군가 네이버 클라우드용 webhook을 작성한 것](https://github.com/topics/cert-manager-webhook)이 있는지 확인해보았지만, 따로 검색되지 않았다. 그래서 직접 작성해서 사용해보기로 결정하였다.

## Naver Cloud SDK

[전체 예제 코드](https://github.com/jayground8/example-openapi-generator)

[Naver Cloud에서 Global DNS API를 제공](https://api-gov.ncloud-docs.com/docs/networking-globaldns-record)하고 있다. [이미 Naver Cloud에서 공식으로 제공하는 Go SDK](https://github.com/NaverCloudPlatform/ncloud-sdk-go-v2)를 활용하려고 했지만, 이상하게도 Global DNS 서비스는 제공하지 않고 있었다. 그래서 이부분도 직접 작성하는 것으로 결정하게 되었다. GO SDK 코드를 확인하니깐, [Swagger Codegen](https://github.com/swagger-api/swagger-codegen)을 사용하여 Client 코드를 생성하고 있었다. 그래서 동일한 방식으로 Client 코드를 작성해보기로 하였다. 나는 Swagger Codegen 대신에 [OpenAPI Generator](https://openapi-generator.tech/docs/installation/)를 사용하였다.

Naver Cloud의 Key값을 가져오는 것과 Naver Cloud 인증을 위해서 Header 값을 생성하는 것은 네이버 클라우드 공식 GO SDK를 가져와서 사용하였다. Naver Cloud의 Key는 먼저 환경변수에서 가져오는 것을 시도하고, 없으면 설정파일 `~/.ncloud/configure`에서 가져오는 것을 시도한다. 이것도 실패하면 이제 마지막으로 서버에서 MetaData URL로 요청하여 가져오게 된다. 요청하였을 때, 해당 서버에 부여된 Role이 있으면 해당 권한을 가진 Key값을 가져 온다.

예를 들어서 서버에서 아래와 같이 요청을 하면 해당 서버에 주어진 Role ID라 리턴된다. 네이버 클라우드에서 서버에 복수의 Server Role을 부여할 수는 없다. 그래서 복수의 Role을 Server에 연결해도 처음에 연결한 RoleId만 반환한다.

```bash
curl http://169.254.169.254/latest/meta-data/iam/security-credentials
```

그 RoleId를 사용하여 아래와 같이 요청을 하면 Key가 발급되는 것을 확인할 수 있다.

```bash
$ curl http://169.254.169.254/latest/meta-data/iam/security-credentials/{role Id}
{
  "Type" : "NCP-HMAC",
  "AccessKeyId" : "{발근된 accessKeyId}",
  "SecretAccessKey" : "{발급된 SecretAccessKey}",
  "Expiration" : "2024-01-23T22:58:28Z",
  "Token" : "",
  "LastUpdated" : "2024-01-23T22:58:28Z",
  "Code" : "Success"
}
```

[네이버 클라우드 Global DNS API 문서](https://api-gov.ncloud-docs.com/docs/networking-globaldns-record)을 보고 OpenAPI 3.1 Specification에 맞춰서 아래와 같이 작성했다.

`openapi.yml`

```yaml
openapi: '3.1.0'
info:
  version: 1.0.0
  title: ncloud
servers:
  - url: https://globaldns.apigw.gov-ntruss.com/dns/v1
    description: ncloud server
paths:
  /ncpdns/record/apply/{domainId}:
    put:
      summary: 도메인 설정
      operationId: applyRecordChange
      parameters:
        - in: path
          name: domainId
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 정상 응답
  /ncpdns/domain:
    post:
      summary: 도메인 생성
      operationId: postDomain
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                comments:
                  type: string
                name:
                  type: string
      responses:
        '200':
          description: 정상 응답
    get:
      summary: 도메인 조회
      operationId: getDomain
      parameters:
        - in: query
          name: page
          required: true
          schema:
            type: integer
            format: int32
        - in: query
          name: size
          required: true
          schema:
            type: integer
            format: int32
        - in: query
          name: domainName
          required: false
          schema:
            type: string
      responses:
        '200':
          description: 정상응답
          content:
            application/json:
              schema:
                type: object
                properties:
                  content:
                    type: array
                    items:
                      type: object
                      properties:
                        id:
                          type: integer
                          format: int64
                        name:
                          type: string
                        completeYn:
                          type: boolean
                        status:
                          type: string
  /ncpdns/record/{domainId}:
    get:
      summary: 레코드 조회
      operationId: getRecord
      parameters:
        - in: path
          name: domainId
          required: true
          schema:
            type: integer
            format: int64
        - in: query
          name: page
          required: true
          schema:
            type: integer
            format: int32
        - in: query
          name: size
          required: true
          schema:
            type: integer
            format: int32
        - in: query
          name: recordType
          required: false
          schema:
            type: string
        - in: query
          name: searchContent
          required: false
          schema:
            type: string
      responses:
        '200':
          description: 정상응답
          content:
            application/json:
              schema:
                type: object
                properties:
                  content:
                    type: array
                    items:
                      type: object
                      properties:
                        name:
                          type: string
                        host:
                          type: string
                        type:
                          type: string
                        content:
                          type: string
                        ttl:
                          type: integer
                          format: int64
                        aliasId:
                          type: integer
                          format: int64
                        id:
                          type: integer
                          format: int64
                        domainName:
                          type: string
                        createdDate:
                          type: integer
                          format: int64
                        modifiedDate:
                          type: integer
                          format: int64
                        defaultYn:
                          type: boolean
                        applyYn:
                          type: boolean
                        aliasYn:
                          type: boolean
                        lbPlatform:
                          type: string
                        lbYn:
                          type: boolean
                        delYn:
                          type: boolean
    post:
      summary: 레코드 생성
      operationId: createRecord
      parameters:
        - in: path
          name: domainId
          required: true
          schema:
            type: integer
            format: int64
      requestBody:
        content:
          application/json:
            schema:
              type: array
              items:
                type: object
                properties:
                  host:
                    type: string
                  type:
                    type: string
                  content:
                    type: string
                  ttl:
                    type: integer
                    format: int64
                  aliasId:
                    type: integer
                    format: int64
                  lbId:
                    type: integer
                    format: int64
                required:
                  - host
                  - type
                  - content
                  - ttl
      responses:
        '200':
          description: 정상 응답
    put:
      summary: 레코드 수정
      operationId: updateRecord
      parameters:
        - in: path
          name: domainId
          required: true
          schema:
            type: integer
            format: int64
      requestBody:
        content:
          application/json:
            schema:
              type: array
              items:
                type: object
                properties:
                  id:
                    type: integer
                    format: int64
                  host:
                    type: string
                  type:
                    type: string
                  content:
                    type: string
                  ttl:
                    type: integer
                    format: int64
                  aliasId:
                    type: integer
                    format: int64
                  lbId:
                    type: integer
                    format: int64
                required:
                  - id
                  - host
                  - type
                  - content
                  - ttl
      responses:
        '200':
          description: 정상 응답
    delete:
      summary: 레코드 삭제
      operationId: deleteRecord
      parameters:
        - in: path
          name: domainId
          required: true
          schema:
            type: integer
            format: int64
      requestBody:
        content:
          application/json:
            schema:
              type: array
              items:
                type: integer
                format: int64
      responses:
        '200':
          description: 정상 응답
components:
  parameters:
    timestampHeader:
      in: header
      name: 'x-ncp-apigw-timestamp'
      schema:
        type: string
      required: true
    accessKeyHeader:
      in: header
      name: 'x-ncp-iam-access-key'
      schema:
        type: string
      required: true
    signatureHeader:
      in: header
      name: 'x-ncp-apigw-signature-v2'
      schema:
        type: string
      required: true
```

작성한 문서를 바탕으로 openapi-generator로 client 코드를 생성한다. 해당되는 client코드가 go module을 별도로 생성하지 않도록 `withGoMod=false`를 설정하였다.

```bash
docker run --rm -v ${PWD}:/local openapitools/openapi-generator-cli generate \
    -i /local/openapi.yml \
    -g go \
    --additional-properties=withGoMod=false \
    -o /local/client
```

그 다음에는 생성된 코드 중 `client.go`의 `prepareRequest` method안에 Naver Cloud 인증을 위한 Header 값을 설정하는 코드를 추가한다.

```go
queryString := ""
if len(url.RawQuery) > 0 {
  queryString = "?" + url.RawQuery
}

if auth := credentials.LoadCredentials(credentials.DefaultCredentialsChain()); auth != nil {
  timestamp := strconv.FormatInt(time.Now().UnixNano()/int64(time.Millisecond), 10)
  signer := hmac.NewSigner(auth.SecretKey(), crypto.SHA256)
  signature, _ := signer.Sign(method, path+queryString, auth.AccessKey(), timestamp)

  localVarRequest.Header.Add("x-ncp-apigw-timestamp", timestamp)
  localVarRequest.Header.Add("x-ncp-iam-access-key", auth.AccessKey())
  localVarRequest.Header.Add("x-ncp-apigw-signature-v1", signature)
}
```

환경변수에 아래와 같이 추가하고,

```bash
export NCLOUD_ACCESS_KEY={accessKey}
export NCLOUD_SECRET_KEY={secretKey}
export NCLOUD_API_GW=https://ncloud.apigw.gov-ntruss.com
```

테스트로 `go run main.go` 명령어로 main 함수를 실행한다. 해당 코드는 domain를 조회하고, Record를 생성, 수정, 삭제를 하게 된다.

```go
package main

import (
	"context"
	"fmt"
	"os"

	openapi "github.com/jayground8/example-openapi-generator/client"
)

func getDomainId(client *openapi.APIClient, domainName string) *int64 {
	req := client.DefaultAPI.GetDomain(context.Background()).
		Page(0).
		Size(10).
		DomainName(domainName)
	value, res, err := client.DefaultAPI.GetDomainExecute(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	if res.StatusCode != 200 || len(value.GetContent()) <= 0 {
		return nil
	}

	content := value.GetContent()[0]
	println("Id:", *content.Id)
	println("Name:", *content.Name)
	println("Status:", *content.Status)
	println("CompleteYn:", *content.CompleteYn)

	return content.Id
}

func applyRecordChange(client *openapi.APIClient, domainId *int64) {
	req := client.DefaultAPI.ApplyRecordChange(context.Background(), *domainId)
	res, err := client.DefaultAPI.ApplyRecordChangeExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	println(res.StatusCode)
}

func getRecord(client *openapi.APIClient, domainId *int64, recordType string, recordName string) *openapi.GetRecord200ResponseContentInner {
	req := client.DefaultAPI.GetRecord(context.Background(), *domainId).
		Page(0).
		Size(10).
		RecordType(recordType)

	value, res, err := client.DefaultAPI.GetRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	for _, c := range value.GetContent() {
		println("Id:", *c.Id)
		println("Name:", *c.Name)
		println("Host:", *c.Host)
		println("Type:", *c.Type)
		println("Content:", *c.Content)
		if *c.Name == recordName {
			return &c
		}
	}

	return nil
}

func createRecord(client *openapi.APIClient, domainId *int64, host string, recordType string, content string, ttl int64) {
	body := []openapi.CreateRecordRequestInner{{Host: host, Type: recordType, Content: content, Ttl: ttl}}
	req := client.DefaultAPI.CreateRecord(context.Background(), *domainId).
		CreateRecordRequestInner(body)
	res, err := client.DefaultAPI.CreateRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	println(res.StatusCode)
}

func updateRecord(client *openapi.APIClient, domainId *int64, id int64, host string, recordType string, content string, ttl int64) {
	body := []openapi.UpdateRecordRequestInner{{Id: id, Host: host, Type: recordType, Content: content, Ttl: ttl}}
	req := client.DefaultAPI.UpdateRecord(context.Background(), *domainId).
		UpdateRecordRequestInner(body)
	res, err := client.DefaultAPI.UpdateRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	println(res.StatusCode)
}

func deleteRecord(client *openapi.APIClient, domainId *int64, recordId int64) {
	req := client.DefaultAPI.DeleteRecord(context.Background(), *domainId).RequestBody([]int64{recordId})
	res, err := client.DefaultAPI.DeleteRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	println(res.StatusCode)
}

func main() {
	config := openapi.NewConfiguration()
	client := openapi.NewAPIClient(config)
	domainId := getDomainId(client, "yourdomain.com")
	println(*domainId)

	createRecord(client, domainId, "test", "A", "8.8.8.8", 600)
	applyRecordChange(client, domainId)
	record := getRecord(client, domainId, "A", "sub.yourdomain.com")
	println(*record.Name, *record.Id)
	updateRecord(client, domainId, *record.Id, *record.Host, *record.Type, "7.7.7.7", *record.Ttl)
	applyRecordChange(client, domainId)
	deleteRecord(client, domainId, *record.Id)
	applyRecordChange(client, domainId)
}
```

## Naver Cloud Webhook

[전체 예제 코드](https://github.com/jayground8/cert-manager-ncpdns-webhook)

이제 Naver Cloud API를 통해서 정상적으로 도메인 조회, 레코드 생성, 레코드 삭제, 변경 사항 적용등을 테스트해봤으니, cert manager의 webhook 코드를 작성한다. 친절하게 [Webhook Boilerplate 코드](https://github.com/cert-manager/webhook-example)를 제공하고 있어서, 해당 소스코드를 clone해서 작성하였다.

Webhook이 담당하는 로직은 매우 단순하다. Present method에서 `ChallengeRequest`의 값을 통해서 TXT Record를 DNS provider에 등록하면 된다.

```go
func (c *customDNSProviderSolver) Present(ch *v1alpha1.ChallengeRequest) error {
	cfg, err := loadConfig(ch.Config)
	if err != nil {
		return err
	}

	// TODO: do something more useful with the decoded configuration
	fmt.Printf("Decoded configuration %v", cfg)

	// TODO: add code that sets a record in the DNS provider's console
	return nil
}
```

그리고 Present가 완료되고 해당 TXT Record를 DNS provider에서 삭제하면 된다.

```go
func (c *customDNSProviderSolver) CleanUp(ch *v1alpha1.ChallengeRequest) error {
	// TODO: add code that deletes a record from the DNS provider's console
	return nil
}
```

네이버 클라우드 Global DNS에 요청하는 Method들을 아래와 같이 추가하였다.

```go
func (c *ncpDNSProviderSolver) getDomainId(client *openapi.APIClient, domainName string) *int64 {
	req := client.DefaultAPI.GetDomain(context.Background()).
		Page(0).
		Size(10).
		DomainName(domainName)
	value, res, err := client.DefaultAPI.GetDomainExecute(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	if res.StatusCode != 200 || len(value.GetContent()) <= 0 {
		return nil
	}

	content := value.GetContent()[0]

	return content.Id
}

func (c *ncpDNSProviderSolver) applyRecordChange(client *openapi.APIClient, domainId *int64) {
	req := client.DefaultAPI.ApplyRecordChange(context.Background(), *domainId)
	res, err := client.DefaultAPI.ApplyRecordChangeExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}
}

func (c *ncpDNSProviderSolver) getRecordId(client *openapi.APIClient, domainId *int64, recordType string, recordName string, recordValue string) *int64 {
	req := client.DefaultAPI.GetRecord(context.Background(), *domainId).
		Page(0).
		Size(10).
		RecordType(recordType)

	value, res, err := client.DefaultAPI.GetRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}

	for _, c := range value.GetContent() {
		if c.GetHost() == recordName && c.GetContent() == fmt.Sprintf("\"%s\"", recordValue) {
			recordId := c.GetId()
			return &recordId
		}
	}

	return nil
}

func (c *ncpDNSProviderSolver) createRecord(client *openapi.APIClient, domainId *int64, host string, recordType string, content string, ttl int64) {
	body := []openapi.CreateRecordRequestInner{{Host: host, Type: recordType, Content: content, Ttl: ttl}}
	req := client.DefaultAPI.CreateRecord(context.Background(), *domainId).
		CreateRecordRequestInner(body)
	res, err := client.DefaultAPI.CreateRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}
}

func (c *ncpDNSProviderSolver) deleteRecord(client *openapi.APIClient, domainId *int64, recordId int64) {
	req := client.DefaultAPI.DeleteRecord(context.Background(), *domainId).RequestBody([]int64{recordId})
	res, err := client.DefaultAPI.DeleteRecordExecute(req)

	if err != nil {
		fmt.Fprintf(os.Stderr, "Full HTTP response: %v\n", res)
		panic(err)
	}
}
```

그리고 `Present`에서는 아래와 같이 코드를 추가하였다. `ch.ResolvedZone`의 경우에는 FQDN으로 오기 떄문에 마지막에 `.`이 포함되어 `example.com.`이 된다. 그런데 Naver Cloud API에서 도메인 이름으로 검색할 때 마지막에 `.`를 포함하면 `example.com`으로 찾을수가 없다. 그래서 마지막 `.`를 제거 해주는 코드를 추가했다. 그리고 record를 등록할 때 Naver Cloud API에서는 host로 subdomain만 보내도록 되어 있다. 예를 들어서 `tutorial.example.com`으로 등록하고 싶으면, `tutorial` 값으로 요청해야 한다. 그래서 `ch.ResolvedFQDN` 값을 `.`으로 split해서 index 0 값만 가져와서 사용하도록 하였다. 마지막으로 이미 같은 값으로 Record를 다시 요청하더라도 이에 대해서 처리할 수 있어야 한다. 그래서 동일한 Record가 기존에 존재하는지 확인하고, 없을 때만 Record를 생성하도록 작성하였다.

```go
func (c *ncpDNSProviderSolver) Present(ch *v1alpha1.ChallengeRequest) error {
	cfg, err := loadConfig(ch.Config)
	if err != nil {
		return err
	}

	// TODO: do something more useful with the decoded configuration
	fmt.Printf("Decoded configuration %v", cfg)

	// TODO: add code that sets a record in the DNS provider's console
	config := openapi.NewConfiguration()
	client := openapi.NewAPIClient(config)
	c.ncpDNSClient = client
	domainName := strings.TrimSuffix(ch.ResolvedZone, ".")
	domainId := c.getDomainId(client, domainName)
	host := strings.Split(ch.ResolvedFQDN, ".")[0]
	recordId := c.getRecordId(client, domainId, "TXT", host, ch.Key)
	if recordId == nil {
		c.createRecord(client, domainId, host, "TXT", ch.Key, 300)
		c.applyRecordChange(client, domainId)
	}

	return nil
}
```

`CleanUp`에서는 같은 Record가 존재할 때 삭제하도록 작성하였다.

```go
func (c *ncpDNSProviderSolver) CleanUp(ch *v1alpha1.ChallengeRequest) error {
	// TODO: add code that deletes a record from the DNS provider's console
	domainName := strings.TrimSuffix(ch.ResolvedZone, ".")
	domainId := c.getDomainId(c.ncpDNSClient, domainName)
	host := strings.Split(ch.ResolvedFQDN, ".")[0]
	recordId := c.getRecordId(c.ncpDNSClient, domainId, "TXT", host, ch.Key)
	if recordId != nil {
		c.deleteRecord(c.ncpDNSClient, domainId, *recordId)
		c.applyRecordChange(c.ncpDNSClient, domainId)
	}
	return nil
}
```

Cert manager에서 테스트 프레임워크도 제공하기 때문에 `main_test.go`를 아래와 같이 작성하여 테스트하였다. `TEST_ZONE_NAME` 환경변수를 소유하고 있는 도메인으로 설정한다. 그리고 Naver Cloud Global DNS 서비스에 접근할 수 있는 권한의 Key값도 환경변수로 설정한다.

```bash
export TEST_ZONE_NAME=yourdomain.com
export NCLOUD_ACCESS_KEY={accessKey}
export NCLOUD_SECRET_KEY={secretKey}
export NCLOUD_API_GW=https://ncloud.apigw.gov-ntruss.com
```

`dns.SetDNSServer("ns1-1.ns-ncloud.com:53")`는 DNS server URL를 추가한다. Record가 정상적으로 등록되었는지 해당 Name Server에 질의하여 확인한다.

```go
package main

import (
	"os"
	"testing"

	"github.com/cert-manager/cert-manager/test/acme"
)

var (
	zone = os.Getenv("TEST_ZONE_NAME")
)

func TestRunsSuite(t *testing.T) {
	// The manifest path should contain a file named config.json that is a
	// snippet of valid configuration that should be included on the
	// ChallengeRequest passed as part of the test cases.
	//

	// Uncomment the below fixture when implementing your custom DNS provider
	//fixture := acmetest.NewFixture(&customDNSProviderSolver{},
	//	acmetest.SetResolvedZone(zone),
	//	acmetest.SetAllowAmbientCredentials(false),
	//	acmetest.SetManifestPath("testdata/my-custom-solver"),
	//	acmetest.SetBinariesPath("_test/kubebuilder/bin"),
	//)
	// solver := example.New("59351")
	fixture := dns.NewFixture(&ncpDNSProviderSolver{},
		dns.SetResolvedZone(zone),
		dns.SetManifestPath("testdata/my-custom-solver"),
		dns.SetUseAuthoritative(false),
		dns.SetDNSServer("ns1-1.ns-ncloud.com:53"),
	)
	//need to uncomment and  RunConformance delete runBasic and runExtended once https://github.com/cert-manager/cert-manager/pull/4835 is merged
	//fixture.RunConformance(t)
	fixture.RunBasic(t)
	fixture.RunExtended(t)
}
```

이제 `make test` 명령어를 실행하면 테스트가 진행이 된다.

## Container Image, Helm Chart 배포

테스트까지 완료가 되었고, 이제 해당 webhook 코드를 Helm Chart로 배포해서 사용해본다. 이미 작성된 다양한 DNS provider webhook 소스코드들이 있어서, 참고하여 작성을 하였다. 기본적으로 Boilerplate 코드에 Chart template도 작성되어 있어서 따로 수정할게 별로 없다. 아래와 같이 두 가지 파일을 수정했다.

`Chart.yaml`

```yaml
apiVersion: v1
appVersion: '0.1.4'
description: Cert manager naver cloud webhook Helm chart
name: ncpdns-webhook
version: 0.1.4
```

`groupName`은 기본값 `acme.mycompany.com`대신에 원하는 값을 사용하면 된다. container repository는 무료로 사용할 수 있는 [Github Container Registry](https://github.blog/2020-09-01-introducing-github-container-registry/)를 이용하였다. 따라서 `ghcr.io`로 설정이 되어 있다.

`values.yaml`

```yaml
# The GroupName here is used to identify your company or business unit that
# created this webhook.
# For example, this may be "acme.mycompany.com".
# This name will need to be referenced in each Issuer's `webhook` stanza to
# inform cert-manager of where to send ChallengePayload resources in order to
# solve the DNS01 challenge.
# This group name should be **unique**, hence using your own company's domain
# here is recommended.
groupName: acme.mycompany.com

certManager:
  namespace: cert-manager
  serviceAccountName: cert-manager

image:
  repository: ghcr.io/jayground8/cert-manager-ncpdns-webhook
  tag: 0.1.4
  pullPolicy: IfNotPresent

nameOverride: ''
fullnameOverride: ''

service:
  type: ClusterIP
  port: 443

resources:
  {}
  # We usually recommend not to specify default resources and to leave this as a conscious
  # choice for the user. This also increases chances charts run on environments with little
  # resources, such as Minikube. If you do want to specify resources, uncomment the following
  # lines, adjust them as necessary, and remove the curly braces after 'resources:'.
  # limits:
  #  cpu: 100m
  #  memory: 128Mi
  # requests:
  #  cpu: 100m
  #  memory: 128Mi

nodeSelector: {}

tolerations: []

affinity: {}
```

Container Image Build&Push와 Helm Chart 배포는 Github action을 작성하여 진행한다. [chart-releaser-action](https://github.com/helm/chart-releaser-action)이 Github에서 release를 하고, Helm chart를 publish한다. (Helm chart 버전을 올려서 작업하다가 기존 버전의 Github release artifact를 지웠다가 문제가 생겼다. 그래서 0.1.4까지 올려서 테스트를 하게 되었다. 그리고 github action을 tag trigger로 설정했을 때, `chart-releaser-action`가 tag도 생성해서 그런지 Github action pipeline 실행 중에 에러가 발생했다. 최종적으로 main branch에 push할 때 trigger되도록 수정하였다.) `chart-releaser-action`을 사용할 때 `gh-pages`가 필요하여서 해당 branch도 생성해야 한다.

`.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches:
      - main

jobs:
  release:
    permissions:
      contents: write
      packages: write
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Configure Git
        run: |
          git config user.name "$GITHUB_ACTOR"
          git config user.email "$GITHUB_ACTOR@users.noreply.github.com"

      - name: Install Helm
        uses: azure/setup-helm@v3

      - name: Run chart-releaser
        uses: helm/chart-releaser-action@v1.6.0
        env:
          CR_TOKEN: '${{ secrets.GITHUB_TOKEN }}'

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to GitHub Docker Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Inject slug/short variables
        uses: rlespinasse/github-slug-action@v4

      - name: Build and push
        id: docker_build
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/${{ env.GITHUB_REPOSITORY_OWNER_PART_SLUG }}/${{ env.GITHUB_REPOSITORY_NAME_PART_SLUG }}:0.1.4
```

## Kubernetes에서 사용

이제 Helm Chart가 정상적으로 Publish되었기 때문에 아래처럼 Helm chart를 등록할 수 있다.

```bash
helm repo add cert-manager-ncpdns-webhook https://jayground8.github.io/cert-manager-ncpdns-webhook
```

```bash
$ helm search repo cert-manager-ncpdns-webhook
NAME                                            CHART VERSION   APP VERSION     DESCRIPTION
cert-manager-ncpdns-webhook/ncpdns-webhook      0.1.4           0.1.4           Cert manager naver cloud webhook Helm chart
```

이제 cert-manager가 있는 namespace에 resource들을 helm으로 설치한다.

```bash
kubectl ns cert-manager
helm install cert-manager-ncpdns-webhook cert-manager-ncpdns-webhook/ncpdns-webhook
```

설치가 정상적으로 되면 아래처럼 Pod가 정상적으로 실행중인 것을 확인할 수 있다.

```bash
$ kubectl get pod -n cert-manager
NAME                                           READY   STATUS    RESTARTS   AGE
cert-manager-ncpdns-webhook-atb426c46-aberls   1/1     Running   0          4h6m
```

이제 webhook이 정상적으로 설치가 되었으니 인증서를 발급하기 위해서 `ClusterIssuer`와 `Certificate` 리소스를 생성한다. webhook 설정에서 `groupName`을 위에서 Helm Chart Value로 설정한 groupName `acme.mycompany.com`을 사용해야 한다. 만약 이부분을 변경해서 배포하였다면, 그것에 맞춰서 설정해줘야 한다. solver이름은 `ncp-dns-solver`로 설정을 해야 한다. webhook 코드에서 `main.go`에 아래와 같이 작성했기 때문이다.

`main.go`

```go
func (c *ncpDNSProviderSolver) Name() string {
	return "ncp-dns-solver"
}
```

해당 내용을 반영하면 아래와 같이 작성할 수 있다.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    # The ACME server URL
    server: https://acme-v02.api.letsencrypt.org/directory
    # Email address used for ACME registration
    email: jayground8@gmail.com
    # Name of a secret used to store the ACME account private key
    privateKeySecretRef:
      name: letsencrypt-prod
    # Enable the HTTP-01 challenge provider
    solvers:
      - dns01:
          webhook:
            groupName: acme.mycompany.com
            solverName: ncp-dns-solver
        selector:
          dnsNames:
            - example.com
            - '*.example.com'

---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-tls
spec:
  secretName: example-com-tls
  dnsNames:
    - example.com
    - '*.example.com'
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

해당 resource를 Kubernetes에서 생성하면 Cert Manager과 webhook을 통해서 DNS-01 challenge를 수행한다. 정상적으로 완료되면 `example-com-tls` Secret에 인증서 값이 저장되게 된다.

## 결론

OpenAPI generator와 Golang에 익숙하지 않아서 조금 시간이 걸렸지만, Webhook의 로직은 매우 단순하고 boilerplate 코드와 테스트 프레임워크를 제공하여 쉽게 작성할 수 있었다. 나중에 네이버 클라우드와 공공 클라우드에서 사용할 수 있도록 API host URL을 선택할 수 있도록 수정하고, debug logging과 error handling을 개선해야겠다. 그리고 Secret에서 가져와서 Naver Cloud의 key를 설정하지 않게 했는데, 범용적으로 사용하기 위해서는 이것도 지원하는게 좋겠다.
