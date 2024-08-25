---
title: '구글 켈린더 반복 일정을 API 생성/수정/삭제 하는 법'
date: '2024-08-25'
tags: ['development']
images: ['/static/images/social-banner.png']
summary: '구글 켈린더에서 RFC 5545로 정의된 값으로 반복일정을 생성할 수 있다. 그런데 구글 켈린더의 반복 일정을 API로 생성/수정/삭제 하는 과정에서 삽질을 하게 되었다.😂 혹시나 누군가 구글 켈린더 반복일정을 API로 수정/변경/삭제 해야하는 경우, 이 블로그 글을 통해서 불필요하게 삽질을 하지 않기 바라며 작성했다. 반복일정을 수정/삭제 할 때 선택하는 세 가지 옵션(이 일정, 모든 일정, 이 일정 및 향후 일정)에 따라서 이벤트 id를 다르게 설정하여 요청해야 한다.'
---

## 구글 켈린더 반복 일정

구글 켈린더에서 반복 일정을 설정할 수 있다. 아래 그림처럼 `매일`을 설정하면 동일한 이벤트가 매일 생성된다.

<center>
  <img src="/static/images/gcalendar-repeated-events.png" alt="set a repeated event" />
</center>

이렇게 설정된 이벤트를 [Google Calendar API를 통해서 확인](https://developers.google.com/calendar/api/v3/reference/events/list)하면, 아래과 같은 것을 확인 할 수 있다. 여기서 `recurrence` 값을 보면, `"RRULE:FREQ=DAILY"`이라고 설정되어 있다. Frequency가 Daily라고 된 값을 보면, `매일` 반복 일정을 설정한 설정값이라는 것을 쉽게 추측할 수 있다. 이렇게 반복 일정은 `RFC 5545`에 정의된 형식으로 recurrence에 저장이 된다.

```json
{
  "kind": "calendar#event",
  "etag": "\"3449127746484000\"",
  "id": "6jnf5omssa5b89cek4mu9pfnve",
  "status": "confirmed",
  "htmlLink": "https://www.google.com/calendar/event?eid=NmpuZjVvbXNzYTViODljZWs0bXU5cGZudmVfMjAyNDA4MjhUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
  "created": "2024-08-25T05:31:13.000Z",
  "updated": "2024-08-25T05:31:13.242Z",
  "summary": "test",
  "creator": {
    "email": "jayground8@gmail.com",
    "self": true
  },
  "organizer": {
    "email": "jayground8@gmail.com",
    "self": true
  },
  "start": {
    "dateTime": "2024-08-28T20:00:00+09:00",
    "timeZone": "Asia/Seoul"
  },
  "end": {
    "dateTime": "2024-08-28T21:00:00+09:00",
    "timeZone": "Asia/Seoul"
  },
  "recurrence": ["RRULE:FREQ=DAILY"],
  "iCalUID": "6jnf5omssa5b89cek4mu9pfnve@google.com",
  "sequence": 0,
  "reminders": {
    "useDefault": true
  },
  "eventType": "default"
}
```

만약 반복일정 설정을 `주중 매일`이라고 하면 `recurrence` 값이 아래와 같이 설정된다. 이것도 직관적으로 Monday, Tuesday, Wednesday, Thursday, Friday만 설정된 것을 이해할 수 있다.

```bash
"RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TH,TU,WE"
```

반복일정 설정에서 `맞춤`을 선택하면 아래와 같이 더 세부적인 설정을 할 수 있다. 이벤트가 반복되는데 언제까지 반복되는지 설정할 수도 있고, 반복 횟수를 설정할 수도 있다.

<center>
  <img src="/static/images/gcalendar-repeated-events2.png" alt="advanced options for repeated events" />
</center>

9월 27일까지만 반복되도록 설정하면 아래와 같이 `UNTIL`이 사용되어 아래와 같이 정의가 된다.

```bash
RRULE:FREQ=DAILY;UNTIL=20240927T145959Z
```

30회 반복으로 설정하면 아래와 같이 `COUNT`가 사용되어 정의가 된다. 이렇게 반복일정을 설정해서 생성하면 30번만 해당 일정이 생성된다.

```bash
RRULE:FREQ=DAILY;COUNT=30
```

### singleEvents 설정

[구글 켈린더 이벤트 list API를 보면 singleEvents라는 parameter가 있고](https://developers.google.com/calendar/api/v3/reference/events/list), 아래처럼 정의가 되어 있다.

> Whether to expand recurring events into instances and only return single one-off events and instances of recurring events, but not the underlying recurring events themselves. Optional. The default is False.

해당 parameter를 True로 설정하면 위에처럼 하나의 Event에 recurrence 값을 가지는 것이 아니라, 반복되는 이벤트가 개별 이벤트로 보이게 된다. 예를 들어서 28일부터 매일 반복되는 일정을 생성했다고 해보자. 그럼 28일의 이벤트, 29일의 이벤트, 30일의 이벤트처럼 개별 이벤트 값으로 내려주게 된다. 그리고 실제로 List API로 요청하면, 아래처럼 `recurrence` 항목은 없고 `recurringEventId` 항목이 생긴 것을 확인할 수 있다.

```json
[
  {
    "kind": "calendar#event",
    "etag": "\"3449130081560000\"",
    "id": "6jnf5omssa5b89cek4mu9pfnve_20240828T110000Z",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=NmpuZjVvbXNzYTViODljZWs0bXU5cGZudmVfMjAyNDA4MjhUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T05:31:13.000Z",
    "updated": "2024-08-25T05:50:40.780Z",
    "summary": "test",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-28T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-28T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurringEventId": "6jnf5omssa5b89cek4mu9pfnve",
    "originalStartTime": {
      "dateTime": "2024-08-28T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "iCalUID": "6jnf5omssa5b89cek4mu9pfnve@google.com",
    "sequence": 1,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  },
  {
    "kind": "calendar#event",
    "etag": "\"3449130081560000\"",
    "id": "6jnf5omssa5b89cek4mu9pfnve_20240829T110000Z",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=NmpuZjVvbXNzYTViODljZWs0bXU5cGZudmVfMjAyNDA4MjlUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T05:31:13.000Z",
    "updated": "2024-08-25T05:50:40.780Z",
    "summary": "test",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-29T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-29T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurringEventId": "6jnf5omssa5b89cek4mu9pfnve",
    "originalStartTime": {
      "dateTime": "2024-08-29T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "iCalUID": "6jnf5omssa5b89cek4mu9pfnve@google.com",
    "sequence": 1,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  }
]
```

이벤트 `id` 값을 주의 깊게 보자. 이벤트 id값이 아래처럼 recurringEventId에 이벤트 시작날짜값이 `_` 뒤에 붙어 있는 것을 확인할 수 있다.

```bash
6jnf5omssa5b89cek4mu9pfnve_20240828T110000Z
6jnf5omssa5b89cek4mu9pfnve_20240829T110000Z
```

### 반복 일정 수정/삭제

반복 설정된 이벤트를 수정할 때 아래와 같은 옵션들이 나오게 된다. 예를 들어서 이벤트의 summary를 test에서 test2로 변경했을 때, `이 일정`은 반복되는 이벤트 중에 선택한 이벤트만 test2로 바꾼다. `이 일정 및 향후 일정`을 선택하면, 선택한 이벤트와 이후 반복되는 이벤트들만 test2로 변경된다. 선택한 이벤트 이전의 이벤트들은 test로 유지된다. 마지막으로 `모든 일정`을 선택하면 해당 반복일정의 모든 이벤트가 test2로 변경된다.

<center>
  <img src="/static/images/gcalendar-repeated-events3.png" alt="edit a repeated event" />
</center>

그럼 Google Calendar API로 반복 일정 Event를 수정하려면 어떻게 해야 할까? singleEvents를 False로 설정하였을 때, 이벤트에는 recurrence 값이 있었다. 이 때의 id가 recurringEventId가 된다. singleEvents를 True로 설정했을 때, 이벤트에는 recurrence 항목이 없어지고, 이벤트의 id는 recurringEventId에 `_` + 날짜 값으로 설정된다.

예를 들어서 singleEvents가 True일 때, 28일 이벤트의 id는 아래와 같다.

```bash
6jnf5omssa5b89cek4mu9pfnve_20240828T110000Z
```

29일 이벤트의 id는 아래와 같이 된다. 이렇게 singleEvents를 True로 설정했을 때 반복되는 일정에 대해서 개별적인 이벤트로 내려주게 되고, 해당 이벤트의 id는 이런 형식으로 생성되는 것을 확인할 수 있었다.

```bash
6jnf5omssa5b89cek4mu9pfnve_20240829T110000Z
```

#### 이 일정만 변경/삭제

`이 일정` 옵션을 선택해서 해당 이벤트만 변경/삭제할 때는 `singleEvents` 값을 True로 설정해서 받은 개별 이벤트 id를 활용하면 된다. 28일부터 매일 반복되는 일정에서 29일의 이벤트만 수정/삭제하고 싶으면, 아래의 id값을 사용해서 수정/삭제하면 된다.

```bash
6jnf5omssa5b89cek4mu9pfnve_20240829T110000Z
```

#### 모든 일정 변경/삭제

`모든 일정` 옵션을 선택해서 변경/삭제할 때는 `singleEvents` 값을 False로 설정해서 받은 이벤트 id를 활용하면 된다. recurringEventId로 사용되는 이 id로 요청하면 구글 켈린더에서 보이는 개별 이벤트들이 한번에 수정되거나 삭제된다.

```bash
6jnf5omssa5b89cek4mu9pfnve
```

#### 이 일정 및 향후 일정 변경/삭제

`이 일정 및 향후 일정`을 선택해서 수정하거 삭제하면 아래와 같이 R를 추가한 id를 이용한다.

```bash
6jnf5omssa5b89cek4mu9pfnve_R20240830T110000Z
```

예를 들어서 Patch API로 28일부터 매일 반복되는 일정을 30일부터는 summary 값이 hello로 보이도록 요청한다. Path parameter에 `R` 값이 붙은 id 값을 설정하여 요청하면 28일, 29일은 그대로 test로 보이고 이 후 이벤트들은 hello로 보인다.

```bash
PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/6jnf5omssa5b89cek4mu9pfnve_R20240830T110000Z
```

List API로 확인을 해보면, 기존 event의 recurrence는 `UNTIL`로 30일까지만 생성되도록 변경이 되어 있다. 그리고 새로운 event 데이터가 30일부터 동일한 recurrence값에 변경된 `hello` summary 값을 가지고 있다. 변경된 이벤트의 id가 우리가 요청한 `R`이 포함된 값인 것을 확인할 수 있다.

```bash
6jnf5omssa5b89cek4mu9pfnve_R20240830T110000
```

```json
[
  {
    "kind": "calendar#event",
    "etag": "\"3449133357984000\"",
    "id": "6jnf5omssa5b89cek4mu9pfnve",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=NmpuZjVvbXNzYTViODljZWs0bXU5cGZudmVfMjAyNDA4MjhUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T05:31:13.000Z",
    "updated": "2024-08-25T06:17:58.992Z",
    "summary": "test",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-28T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-28T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20240829T145959Z"],
    "iCalUID": "6jnf5omssa5b89cek4mu9pfnve@google.com",
    "sequence": 1,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  },
  {
    "kind": "calendar#event",
    "etag": "\"3449133357984000\"",
    "id": "6jnf5omssa5b89cek4mu9pfnve_R20240830T110000",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=NmpuZjVvbXNzYTViODljZWs0bXU5cGZudmVfMjAyNDA4MzBUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T05:31:13.000Z",
    "updated": "2024-08-25T06:17:58.992Z",
    "summary": "hello",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-30T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-30T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurrence": ["RRULE:FREQ=DAILY"],
    "iCalUID": "6jnf5omssa5b89cek4mu9pfnve_R20240830T110000@google.com",
    "sequence": 1,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  }
]
```

만약 `이 일정 및 향후 일정` 옵션으로 30일 이벤트부터 삭제를 하게 되면, 아래와 같이 `UNTIL`로 30일까지만 반복일정의 이벤트가 생성되도록 변경이 된다.

```
DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/6jnf5omssa5b89cek4mu9pfnve_R20240830T110000Z
```

```json
[
  {
    "kind": "calendar#event",
    "etag": "\"3449133887332000\"",
    "id": "2tf5ir7ol803cji26e98egjcu1",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=MnRmNWlyN29sODAzY2ppMjZlOThlZ2pjdTFfMjAyNDA4MjhUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T06:22:01.000Z",
    "updated": "2024-08-25T06:22:23.666Z",
    "summary": "test",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-28T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-28T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20240829T145959Z"],
    "iCalUID": "2tf5ir7ol803cji26e98egjcu1@google.com",
    "sequence": 0,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  }
]
```

### 같은 id로 묶여 있는 경우

위에서 `이 일정 및 향후 일정` 옵션을 선택하여 summary값만 수정하는 예를 설명하였다. 28일부터 매일 반복되는 일정을 만들었고, 구글 켈린더에서는 28일부터 매일 이벤트가 생성된다. 30일부터 `이 일정 및 향후 일정` 옵션으로 summary값을 기존 test에서 hello로 변경하면, 30일부터 생성되는 이벤트는 hello라고 표시된다.

해당 반복 일정의 아무 이벤트나 선택하여 삭제를 할 때, `모든 일정`을 선택하면 어떻게 될까? 기대하는 것처럼 반복 일정으로 만들어진 모든 이벤트가 한꺼번에 삭제 되는 것을 확인할 수 있다.

그런데 이번에는 매일 설정되어 있는 반복일정을 30일부터는 수요일에만 반복일정이 생성되도록 수정해본다. 단순이 summary값만 바꾸는 것이 아니라, 특정 이벤트부터 반복 설정도 변경이 되는 것이다. Patch API로 요청할 때, body에 recurrence 값을 아래와 같이 설정하여 요청한다.

```
PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/6eid366rh6jnbpheakb09n232a_R20240830T110000Z
```

```json
{
  "summary": "hello",
  "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=WE"]
}
```

구글 켈린더에서는 28일, 29일은 test로 이벤트가 있고, 그 이후는 hello라는 이름으로 이벤트가 수요일마다 생성된 것을 확인할 수 있다. hello로 변경된 이벤트를 선택하여 `모든 일정`으로 삭제하면 어덯게 될까?

<center>
  <img src="/static/images/gcalendar-repeated-events4.png" alt="delete a repeated event" />
</center>

<center>
  <img src="/static/images/gcalendar-repeated-events5.png" alt="delete a repeated event" />
</center>

기대와는 다르게 매주 수요일마다 반복되는 hello 이벤트만 모두 삭제되는 것을 확인할 수 있다.

<center>
  <img src="/static/images/gcalendar-repeated-events6.png" alt="how to show a repeated event after deleting it" />
</center>

왜 이렇게 작동하는지 List API로 요청을 해보면 이해할 수 있다. 반복일정을 수정하였을 때, 아래와 같이 이벤트 id가 다른 것을 확인할 수 있다. 하나의 이벤트로 묶인 것이 아니라, 개별적인 이벤트 id로 구분되어 있다. 따라서 `hello`의 이벤트를 `모든 일정`으로 삭제하더라도 해당 이벤트 id로 묶여 있는 이벤트들만 삭제 된 것이다.

```json
[
  {
    "kind": "calendar#event",
    "etag": "\"3449139508622000\"",
    "id": "6eid366rh6jnbpheakb09n232a",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=NmVpZDM2NnJoNmpuYnBoZWFrYjA5bjIzMmFfMjAyNDA4MjhUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T07:07:49.000Z",
    "updated": "2024-08-25T07:09:14.311Z",
    "summary": "test",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-28T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-28T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20240829T145959Z"],
    "iCalUID": "6eid366rh6jnbpheakb09n232a@google.com",
    "sequence": 0,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  },
  {
    "kind": "calendar#event",
    "etag": "\"3449139508622000\"",
    "id": "nmp18k35t4ko1nouo5ddtjkr7g",
    "status": "confirmed",
    "htmlLink": "https://www.google.com/calendar/event?eid=bm1wMThrMzV0NGtvMW5vdW81ZGR0amtyN2dfMjAyNDA4MzBUMTEwMDAwWiBjb2NvbGFuZGlhMDMwM0Bt",
    "created": "2024-08-25T07:07:49.000Z",
    "updated": "2024-08-25T07:09:14.311Z",
    "summary": "hello",
    "creator": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "organizer": {
      "email": "jayground8@gmail.com",
      "self": true
    },
    "start": {
      "dateTime": "2024-08-30T20:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "end": {
      "dateTime": "2024-08-30T21:00:00+09:00",
      "timeZone": "Asia/Seoul"
    },
    "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
    "iCalUID": "nmp18k35t4ko1nouo5ddtjkr7g@google.com",
    "sequence": 1,
    "reminders": {
      "useDefault": true
    },
    "eventType": "default"
  }
]
```

## 결론

구글 켈린더 반복 일정을 API를 통해서 수정 혹은 삭제할 때, 구글 켈린더 어플리케이션 UI에서 `이 일정 및 향후 일정` 옵션으로 수정/삭제 한 것처럼 구현하고 싶었다. 예를 들어서 28일에 `매일` 설정으로 반복일정을 만들고, 30일에 `이 일정 및 향후 일정`으로 summary값을 변경하고 싶었다. 그런데 처음에는 기존 이벤트의 recurrence에 `UNTIL`을 추가하여 29일까지만 반복일정이 생성되도록 Patch API를 요청하고, Insert API로 30일 날짜에 변경된 summary값으로 새로운 반복일정을 생성하였다. 하지만 이러한 구현 방법의 문제는 하나의 이벤트를 선택하여 `모든 일정`으로 생성할 때 모든 이벤트가 삭제되지 않았다. 어떻게 반복일정을 특정 날짜 이후부터 수정하더라도 `모든 일정` 삭제시 다 삭제 될수 있는지 찾아내기 위해서 삽질이 시작되었다.😂 구글켈린더에 생성된 데이터를 List API로 분석하면서 `R`이 추가된 이벤트 id를 사용하여 원하는 구현을 할 수 있는 것을 찾게 되었다.

Patch API로 반복일정을 수정할 때, 아래의 이벤트 id 형식에 따라서 어떻게 변경이 되는지 이해하게 되었다.

```bash
6jnf5omssa5b89cek4mu9pfnve
6jnf5omssa5b89cek4mu9pfnve_20240828T110000Z
6jnf5omssa5b89cek4mu9pfnve_R20240828T110000Z
```
