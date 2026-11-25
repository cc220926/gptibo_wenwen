const form = document.querySelector('[data-help-search]')
const input = document.querySelector('#help-search-input')
const status = document.querySelector('[data-help-results]')

if (form && input && status) {
  const normalize = text => text.normalize('NFKC').toLowerCase()
  const groups = Array.from(document.querySelectorAll('[data-help-group]'), group => ({
    element: group,
    articles: Array.from(group.querySelectorAll('[data-help-article]'), article => ({
      element: article,
      text: normalize(article.dataset.search ?? ''),
    })),
  }))

  function filter() {
    const terms = normalize(input.value).split(/[\s,，、。？！?!：:]+/).filter(Boolean)
    let visible = 0
    for (const group of groups) {
      let groupHasMatches = false
      for (const article of group.articles) {
        const matches = terms.every(term => article.text.includes(term))
        article.element.hidden = !matches
        if (matches) {
          visible++
          groupHasMatches = true
        }
      }
      group.element.hidden = !groupHasMatches
    }
    status.hidden = terms.length === 0
    status.textContent = visible ? `找到 ${visible} 个相关问题` : '没找到相关问题。试试「查单」「付款」或「Session」。'
  }

  input.addEventListener('input', filter)
  form.addEventListener('submit', event => {
    event.preventDefault()
    filter()
  })
  window.addEventListener('pageshow', filter)
  filter()
}
