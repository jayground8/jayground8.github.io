---
title: 'Spark에서 Hive database가 조회가 안 되는 문제'
date: '2024-04-27'
tags: ['spark']
images: ['/static/images/social-banner.png']
summary: 'Spark에서 SparkSession에 hive 설정을 해서 Hive의 데이터를 읽기/쓰기가 가능하다. 하지만 Hive에서 생성한 데이터베이스가 Spark에서는 조회가 되지 않았다. Spark에서 Hive Metastore를 Catalog로 사용할 때, hive-site.xml에 설정된 값을 이해하면 왜 조회가 되지 않는지 이해할 수 있다. hive-site.xml의 metadata.catalog.default 값이 어떻게 영향을 미치지는 살펴봤다.'
---

Spark SQL를 사용할 때, Hive의 데이터에 대해서 읽기/쓰기를 할 수 있다. [Spark 2.4.8의 문서](https://spark.apache.org/docs/2.4.8/sql-data-sources-hive-tables.html)를 보면, 아래와 같이. `SparkSession`에 hive 설정을 해서 사용할 수 있다.

```java
val spark = SparkSession
  .builder()
  .appName("Spark Hive Example")
  .config("spark.sql.warehouse.dir", warehouseLocation)
  .enableHiveSupport()
  .getOrCreate()
```

이렇게 hive 설정을 했을 때, `/etc/spark2/conf/hive-site.xml`에 설정파일이 있으면 해당 설정파일에 의해서 Hive Metastore를 사용할 수 있다. `hive-site.xml`을 보면 `hive.metastore.uris`는 Metastore Thrift server에 접근하기 위해서 thrift protocol로 정의가 되어 있다.

```xml
<property>
	<name>hive.metastore.uris</name>
	<value>thrift://{manager node1},thrift://{manager node2}</value>
</property>
```

그리고 아래와 같이 `metastore.catalog.default`도 설정되어 있다. 이번 글에서는 이 설정값이 어떤 영향을 미치는지 살펴보려고 한다.🧐

```xml
<property>
	<name>metastore.catalog.default</name>
	<value>spark</value>
</property>
```

사용 환경

- Hive: 3.1.2
- Spark: 2.4.8

## catalog란?

Hive를 사용해서 Database나 Table을 생성하면 Hive catalog에 존재하고, Spark를 사용해서 Database나 Table를 생성하면 Spark catalog에 존재하게 된다. Catalog는 어떤 의미를 가지는 것일까?🧐 Catalog는 데이터들의 관계, 정의, 설명등이 보관되어 있는 곳이라고 생각할 수 있겠다. 그래서 Catalog가 더 큰 범주를 가지고, 그 안에 Hive Metastore이 들어간다고 볼 수 있겠다(?).

`Hive를 사용해서 Database나 Table을 생성하면 Hive catalog에 존재하게 된다`는 것은 데이터의 관계, 데이터가 저장된 위치, 데이터의 schema등 다양한 정보들이 Hive catalog에 존재하게 되는데, 그것을 Hive Metastore가 담당하고 있다는 것으로 생각할 수 있겠다. Spark는 catalog를 `in-memory` 방식으로 관리하여 Spark session동안만 유지하게 하거나, `Hive metastore`를 사용하여 지속 가능한 catalog 설정을 할 수 있다. 그리고 `Hive` 환경이 없는 경우에는 Spark 자체적으로 Derby를 이용해서 Hive metastore를 구성한다고 한다. `Spark catalog에 존재`는 설정에 따라서 in-memory, local metastore with Derby, external hive metastore 등에 저장될 수 있다라는 것을 의미한다. 따라서 위에서 `hive-site.xml`에 Hive metastore에 대한 설정들이 되어 있는 Spark의 경우에는 `External hive metastore`가 Spark catalog가 되는 것이다.

## Spark에서 생성한 Database가 Hive에서 조회되지가 않는다

Spark를 Python으로 사용할 때, 아래와 같이 작성할 수 있다. SparkSession에서 `hive-site.xml`의 설정파일에 의해서 Hive Metastore를 사용하도록 자동 설정된다. 간단하게 database를 생성하고, database 목록 조회를 한다.

```py
from os.path import abspath

from pyspark.sql import SparkSession
from pyspark.sql import Row

warehouse_location = abspath('spark-warehouse')

spark = SparkSession \
    .builder \
    .appName("Python Spark SQL Hive integration example") \
    .config("spark.sql.warehouse.dir", warehouse_location) \
    .enableHiveSupport() \
    .getOrCreate()

spark.sql("create database example")
spark.sql("show databases").show()
```

`pyspark`로 해당 python script를 실행하면 Console에 아래와 같은 내용이 출력되는 것을 확인할 수 있다.

```bash
+------------------+
|      databaseName|
+------------------+
|           default|
|        		example|
+------------------+
```

그런데 Hive shell을 통해서 확인하면 새로 생성한 database `example`이 조회되지 않는다.

```bash
$ hive
> show databases;
OK
default
information_schema
sys
```

여기서 `hive-site.xml`의 `metastore.catalog.default` 설정값을 생각해 볼 필요가 있다. 위에서 아래와 같이 `spark`로 설정되어 있다고 설명했었다. Hive에서는 해당 값이 기본값 `hive`로 설정되어 있다. 따라서 해당 설정값을 `spark` -> `hive`로 변경 적용하고, Spark을 재시작한다. 다시 spark에서 database를 조회하면 동일한 목록이 보이게 된다.

```xml
<property>
	<name>metastore.catalog.default</name>
	<value>spark</value>
</property>
```

## metastore catalog는 무엇인가?

`Catalog`, `Hive Metastore`, `Metastore Catalog`등 용어들이 내 머릿속에 혼재되어서 헛갈렸다. `metastore.catalog.default` 설정값에서 `metastore.catalog`는 무엇이란 말인가?🤨 Hive Metastore Thrift Server가 있고, 저장소로 Derby, MySQL, PostgreSQL등 데이터베이스가 사용된다. `metastore.catalog`는 Metastore가 저장소에 저장할 때, Metastore에 저장된 데이터를 namespace처럼 구분하기 위한 이름이라고 생각된다.

네이버 클라우드에서 제공하는 관리형 Hadoop Service에서는 MySQL를 사용하고 있는데, 해당 환경에서 확인을 해보았다. 먼저 `/etc/hive/conf` 경로에서 `hive-site.xml` 파일을 확인해보면 아래처럼 설정이 되어 있다.

`hive-site.xml`

```xml
<property>
	<name>javax.jdo.option.ConnectionURL</name>
	<value>jdbc:mysql://mysql.local:3306/hive_9880</value>
</property>

<property>
	<name>javax.jdo.option.ConnectionUserName</name>
	<value>{username}</value>
</property>
```

이제 mysql client를 통해서 MySQL 접속하여 Schema를 확인해본다.

```bash
mysql -h mysql.local -u {username} -p
```

저장된 데이터를 확인해보면 Hive Metastore를 사용하고 있는 다양한 service들에 대한 Database가 보인다.

```bash
mysql> show databases;
+--------------------+
| Database           |
+--------------------+
| information_schema |
| ambari_9880        |
| grafana_9880       |
| hive_9880          |
| hue_9880           |
| logsearch_9880     |
| oozie_9880         |
| ranger_9880        |
| ranger_kms_9880    |
+--------------------+
```

그리고 `hive_9880` Database에 있는 `DBS` table의 레코드들을 확인해본다.

```bash
mysql> use hive_9880;
mysql> select * from DBS;
```

그러면 Hive에서 만들어진 database와 Spark에서 생성한 `example`이 조회되는 것을 확인할 수 있다. 이렇게 `metadata.catalog.default`에 설정된 값으로 구분이 되어 있고, Metastore Thrift Server가 MySQL 저장소에 Query를 할 때 이 값으로 구분해서 가져오는 것으로 생각된다. (저장소를 MySQL를 사용하는 과정에서 general_log를 보면 Query문이 어떻게 되는지 확인하면 확실하게 알 수 있을 것이다.)

```bash
+------------------+----------+
|NAME              |CTLG_NAME |
+------------------+----------+
|default           |hive      |
|sys               |hive      |
|information_schema|hive      |
|example           |spark     |
+------------------+----------+
```

[Github Pull Request 기록](https://github.com/apache/hive/pull/320)을 보면, catalog 변수를 추가하면서 default로 `hive`를 하도록 하고, Server side에서 설정값으로 변경할 수 있도록 변경이 된 것을 확인할 수 있다. 그리고 Query를 할 때 catalog 값을 사용해서 가져오는 것도 확인할 수 있다.

## 결론

Hive Metastore는 다양한 어플리케이션에서 Metadata를 저장하기 위해서 사용될 수 있다. Spark에서도 메모리에 Metadata를 보관하는 대신에 Hive Metastore를 사용하여 저장소에 보관할 수 있다. 그리고 Spark에서 Hive support option을 통해서 Hive의 데이터에 접근할 수 있다. 그런데 Hive에서 생성한 메타데이터는 `metastore.catalog.default`가 `hive`로 설정되어 저장되고, Spark에서 생성한 메타데이터는 `metastore.catalog.default`가 `spark`로 설정되어 저장된다. 메타데이터를 가져올 때도 이 catalog 이름으로 구분되어 가져오게 된다. 따라서 Spark에서 Hive에서 생성된 데이터베이스를 조회하지 못하게 된다. Spark의 `hive-site.xml` 설정값을 통해서 `metastore.catalog.default`를 `hive`로 설정하면, Hive에서 생성된 데이터베이스를 조회할 수 있게 된다.
