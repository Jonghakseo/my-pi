---
name: to-html
description: 주어진 주제를 "활자본(Book)" 스타일의 단일 HTML 파일로 만든다. 따뜻한 세리프 타이포, 크림색 종이 배경, 장(Chapter) 구조의 격조 있는 문서를 생성한다.
argument-hint: "결제 구조 | 버그 원인 | 에이전틱 코딩 치트시트"
disable-model-invocation: false
---

# to-html

"$ARGUMENTS"를 **활자본(Book) 스타일**의 싱글 페이지 HTML 문서로 만든다.

---

## 1. 콘셉트

- 인쇄된 책 한 권을 펼쳐놓은 듯한 **활자본** 느낌
- 외부 프레임워크 없이 **순수 HTML + 인라인 `<style>`** 만 사용
- 다크 모드 없음, 단일 라이트 테마
- 한국어 기준 (`lang="ko"`)

---

## 2. 폰트

| 용도 | 폰트 | Weight |
|---|---|---|
| 본문/제목 | `Noto Serif KR` (Google Fonts) | 300, 400, 600, 700, 900 |
| 코드/고정폭 | `JetBrains Mono` (Google Fonts) | 400, 500 |

```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@300;400;600;700;900&family=JetBrains+Mono:wght@400;500&display=swap');
--serif: 'Noto Serif KR', 'Georgia', 'Times New Roman', serif;
--mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
```

---

## 3. 색상 팔레트 (따뜻한 회갈색 5색 체계)

채도 높은 색(파랑, 빨강 등) **사용 금지**. 모든 색이 warm gray 계열이어야 한다.

```css
:root {
  --bg:         #faf9f6;   /* 종이색 (따뜻한 흰색) */
  --text:       #2a2a28;   /* 본문 (거의 검정) */
  --text-mid:   #555550;   /* 보조 텍스트 */
  --text-light: #8a8a82;   /* 캡션, 번호, 힌트 */
  --line:       #ddddd5;   /* 구분선 */
  --accent:     #5a4a3a;   /* 강조 (갈색, 제한적 사용) */
  --code-bg:    #f0efea;   /* 코드 배경 */
}
body { background: #f0eeea; }  /* 페이지 바깥 배경 */
```

---

## 4. 레이아웃

```css
.page {
  max-width: 800px;
  margin: 2.5rem auto;
  background: var(--bg);
  padding: 4rem 3.5rem;
  box-shadow: 0 1px 8px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.08);
}
```

- 모바일 반응형: **750px / 550px / 500px** 세 단계 미디어 쿼리
- 750px 이하: padding `2.5rem 1.8rem`, box-shadow 제거

---

## 5. 타이포그래피 규칙

| 속성 | 값 |
|---|---|
| 본문 크기 | `1rem` |
| 본문 행간 | `line-height: 1.95` |
| 정렬 | `text-align: justify` |
| 줄바꿈 | `word-break: keep-all` (한국어 단어 단위) |
| letter-spacing | 레이블 `0.15em`, 제목 `0.02em~0.06em` |
| font-weight 체계 | 300(라이트) → 400(본문) → 600(강조/strong) → 700(제목) → 900(대제목) |
| 안티앨리어싱 | `-webkit-font-smoothing: antialiased` |

---

## 6. 콘텐츠 블록 카탈로그

주제에 맞게 아래 블록들을 **적절히 조합**하여 문서를 구성한다. 모든 블록을 사용할 필요는 없다.

### 6.1 표제 (Title Page)
- 중앙 정렬, 제목(`h1`, 900 weight) + 저자(300 weight, `--text-mid`) + 장식(`— · —`)
- 하단에 `border-bottom: 1px solid var(--line)`, 아래 여백 `3rem`

### 6.2 장 (Chapter)
- `Chapter N` 소문자 레이블 (0.72rem, `--text-light`, letter-spacing 0.15em)
- `h2` 제목 (1.25rem, 700 weight)
- 도입 문단 1~2개

### 6.3 장 구분선 (Separator)
- 장 사이마다 `— · —` 텍스트 구분자
- 중앙 정렬, `--text-light`, letter-spacing 0.5em, 상하 margin 2.5rem

### 6.4 용어 항목 (Entry)
- `h3` 제목 (1.05rem, 700) + 부제 `.sub` (0.82rem, 300, `--text-light`)
- `.body` 설명 (0.95rem, `--text-mid`)
- `.metaphor` 비유 (0.85rem, `--text-light`, 이탤릭)

### 6.5 코드 도표 (Figure)
- `<figure>` 안에 `<pre>` (JetBrains Mono, 0.8rem, `--code-bg` 배경)
- `<figcaption>` 캡션 (0.78rem, 이탤릭, 중앙 정렬)

### 6.6 인용 (Blockquote)
- `border-left: 2px solid var(--line)`
- 0.92rem, `--text-mid`, line-height 1.85

### 6.7 비교 표 (Table)
- 헤더: 하단 `2px solid var(--text-light)`, 0.78rem, 600 weight
- 본문: 하단 `1px solid var(--line)`, 첫 열 `font-weight: 600`
- 마지막 행 하단 border 없음

### 6.8 항목 리스트 (Item List)
- 불릿 없는 리스트 (`list-style: none`)
- 각 항목: `<code>` 라벨 (min-width 155px, 고정폭) + `<span>` 설명 (`--text-mid`)
- flex 레이아웃, baseline 정렬

### 6.9 2열 그리드
- `display: grid; grid-template-columns: 1fr 1fr;`
- 각 항목: 이름(bold) + 설명(0.85rem, `--text-mid`)
- 항목 사이 `border-bottom: 1px solid var(--line)`
- 500px 이하에서 1열로 전환

### 6.10 워크플로우 (Flow)
- 가로 flex 스텝 + `→` 화살표로 연결
- 각 스텝: 이름(bold) + 코드(mono, 연한색) + 설명(작은 글씨)
- 550px 이하에서 세로 전환, 화살표 90도 회전

### 6.11 구조 다이어그램 (Fig-Diagram)
- 상단 라벨 → 화살표(↓) → border 박스
- 박스 내부: 2열 grid (상단) + dashed border-bottom + 3열 grid (하단)
- `<figcaption>` 캡션

### 6.12 마무리 인용 (Closing)
- `border-top` + `border-bottom` 사이에 핵심 요약
- 라벨(0.7rem, letter-spacing 0.12em) + blockquote(1.05rem, 600 weight, 중앙 정렬)

### 6.13 콜로폰 (Colophon)
- 맨 아래, `border-top` 위에 팀명 · 연도
- 0.75rem, `--text-light`, 중앙 정렬

---

## 7. 장식 규칙

- **이모지**: 제목/라벨에만 제한적 사용 (본문 텍스트에는 넣지 않음)
- **border-radius**: 최대 `3px` (코드 블록 등)
- **그라데이션**: 사용 금지
- **드롭 섀도우**: 카드 외곽의 연한 shadow만 허용
- **컬러풀 배지/뱃지**: 사용 금지
- **아이콘 라이브러리**: 사용 금지 (이모지만 허용)

---

## 8. 파일 생성 규칙

1. `/tmp/{주제를-kebab-case로}.html` 에 저장한다 (임시 폴더).
2. 생성 후 `open /tmp/{파일명}.html` 로 브라우저에서 바로 열어 사용자에게 보여준다.
3. 콜로폰에는 `Jonghak Seo · {현재 연도}` 를 넣는다.

---

## 9. 참고: 전체 CSS 골격

아래 CSS를 기반으로 필요한 블록의 스타일만 추가한다.

```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@300;400;600;700;900&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --bg: #faf9f6; --text: #2a2a28; --text-mid: #555550;
  --text-light: #8a8a82; --line: #ddddd5; --accent: #5a4a3a;
  --code-bg: #f0efea;
  --serif: 'Noto Serif KR', 'Georgia', 'Times New Roman', serif;
  --mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--serif); font-weight: 400;
  background: #f0eeea; color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.page {
  max-width: 800px; margin: 2.5rem auto; background: var(--bg);
  padding: 4rem 3.5rem;
  box-shadow: 0 1px 8px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.08);
}
p {
  font-size: 1rem; line-height: 1.95; margin-bottom: 0.9em;
  text-align: justify; word-break: keep-all;
}
@media (max-width: 750px) {
  .page { margin: 0; padding: 2.5rem 1.8rem; box-shadow: none; }
}
```

---

## 10. HTML 골격

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>$ARGUMENTS</title>
  <style>/* 위 CSS 골격 + 필요한 블록 스타일 */</style>
</head>
<body>
<div class="page">

  <!-- 표제 -->
  <div class="title-page">
    <h1>제목</h1>

    <div class="ornament">— · —</div>
  </div>

  <!-- Chapter 1 -->
  <div class="chapter">
    <div class="chapter-head">
      <span class="chapter-num">Chapter 1</span>
      <h2>장 제목</h2>
    </div>
    <p>도입 문단...</p>
    <!-- 블록 카탈로그에서 적절한 요소 조합 -->
  </div>

  <div class="sep">— · —</div>

  <!-- 추가 Chapter들... -->

  <!-- 마무리 -->
  <div class="closing">
    <div class="label">핵심 요약</div>
    <blockquote>핵심 메시지</blockquote>
  </div>

  <div class="colophon">Jonghak Seo · 연도</div>
</div>
</body>
</html>
```
