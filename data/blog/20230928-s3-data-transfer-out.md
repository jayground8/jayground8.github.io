---
title: 'S3에서 Internet으로 데이터 송신한 금액을 bucket별로 확인하기'
date: '2023-09-28'
tags: [aws]
images: ['/static/images/social-banner.png']
summary: '인터넷에서 S3의 file을 다운로드하면 데이터 전송 비용이 발생한다. 서울 리전 기준으로는 처음 월 10TB까지는 GB당 0.126USD 요금이 발생한다. 이렇게 발생한 금액을 S3 bucket별로 나눠서 볼려면 어떻게 해야 할까? AWS Cost and Usage Report 서비스를 사용하면 세부적인 사용내역을 얻을 수 있고, 그 데이터를 분석하면 bucket별로 인터넷 데이터 전송에 의해 발생한 금액을 산출할 수 있다.'
---

## S3 Data transfer 요금

인터넷에서 S3로 데이터를 업로드하는 것은 요금이 발생하지 않지만, 인터넷에서 S3의 object를 다운로드 하는 것은 요금이 발생한다. 서울 기준으로 처음 월 10TB까지는 GB당 0.126 USD 요금이 발생하게 된다. 보통은 인터넷에 file들을 public하게 공유하게 되면 Cloudfront를 사용하게 된다. Cloudfront의 Data transfer 요금이 살짝 저렴하고(S3와 Cloudfront간의 데이터 전송은 요금이 부가되지 않는다.), 전세계에 있는 Edge server에 cache를 하여 S3까지 round trip해서 데이터를 가져오는 것보다 지역적으로 가까운 edge server에서 빠르게 가져올 수 있다. 하지만 경우에 따라서 S3에서 바로 file들을 public하게 제공하게 될 수도 있다.

**이렇게 S3로부터 다운로드해서 발생한 요금을 Bucket별로 어떻게 확인할 수 있을까?** 🤔

AWS console에서 billing 서비스를 통해서 사용내역을 확인할 수 있다. 하지만 S3에 대한 금액은 아래와 같이 S3에 저장한 것에 대한 것과 API 호출을 얼마나 많이 했는지에 대한 것만 나와있다.

<img src="/static/images/billing-s3.png" alt="Billing information about S3 on AWS console" />

이제 인터넷에서 S3에 있는 파일을 다운로드 할 때 발생한 금액에 대해서는 아래처럼 Data Transfer에 다같이 들어가 있다. 따라서 S3 bucket별로 얼마나 인터넷 다운로드가 발생했고, 그에 따라서 금액이 얼마나 발생했는지 알수가 없다. Cost Expoler를 사용해도 마찬가지로 이런 세부적인 데이터를 얻을 수가 없었다.

<img src="/static/images/billing-data-transfer.png" alt="Billing information about Data Transfer on AWS console" />

## Cost and Usage Report

AWS에서는 서비스 별로 사용내역을 자세하게 다운로드 할 수 있는 기능을 제공한다. 아래 그림처럼 AWS console의 `Cost and Usage Report` 메뉴에서 S3에 대한 사용 내역을 다운로드한다.

<img src="/static/images/download-s3-usage-report.png" alt="download s3 usage report on AWS console" />

나는 csv 파일로 다운로드를 하여 Google sheet에서 데이터를 확인하였다. 데이터의 종류는 아래와 같다.

데이터 칼럼

- Service
- Operation
- UsageType
- Resource
- StartTime
- EndTime
- UsageValue

AWS console에서 사용 내역을 다운로드 할 때 서비스를 S3를 선택했기 때문에 모든 데이터의 Service는 AmazonS3가 되고, Operation은 `GetObject`, `PutObject`등 API를 호출하는 것을 보여준다. 나는 인터넷에서 다운로드 하는 것에 관심이 있으니 `GetObject`와 `WebsiteGetObject`를 filter를 하였다. S3를 Web hosting으로도 사용할 수 있는데, `WebsiteGetObject`는 Web hosting 기능을 사용했을 때 발생하는 것으로 판단된다. 그리고 UsageType도 인터넷에서 다운로드 한 것만 filter하기 위해서 `{Region}-DataTransfer-Out-Bytes`와 `DataTransfer-Out-Bytes`만 보았다. 아래처럼 [AWS 문서에서 UsageType 종류에 대한 더 자세한 설명](https://docs.aws.amazon.com/AmazonS3/latest/userguide/aws-usage-report-understand.html)이 있다.

<img src="/static/images/aws-doc-usagetype.png" alt="information about usage type on AWS documents" />

그런데 여기서 Units은 GB이고, Hourly로 나와있었다. 이걸 보고는 `UsageValue`가 `GB`인 걸로 생각했는데, `GB`로는 터무니 없이 너무 많은 데이터로 나와서 혼란스러웠다. 😭 `DataTransfer-Out-Bytes`에 명시되어 있는 것처럼 Byte로 계산을 해야 한다. 나는 Monthly 사용내역을 받아서 StartTime과 EndTime이 한달로 설정되었고, bucket 별로 발생한 UsageValue byte값을 GB당 0.126 USD로 계산하였다.

## 계산 방법

1. bucket별로 filter

- Operation은 `GetOjbect`, `WebsiteGetObject`
- UsageType은 `{Region}-DataTransfer-Out-Byte`, `DataTransfer-Out-Byte`

2. UsageValue를 합산하여 GB로 변환
3. 0.126 USD를 곱하여 대략적인 bucket별 금액 추정
