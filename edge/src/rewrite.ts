/** Rewrite the SPA shell's `<head>` OG/Twitter tags per the request's query
 * string, so social crawlers (which don't run JS) see per-view previews.
 *
 * The static `index.html` ships defaults (og:title/description/image →
 * og-lot.jpg, og:url, og:type, twitter:card). We overwrite the text/image tags
 * that exist and append the ones it lacks (twitter:title/description/image,
 * og:image:width/height/alt).
 */
import type { OgMeta } from './content'

interface Rewrite extends OgMeta {
  imageUrl: string
  pageUrl: string
}

function setContent(value: string) {
  return {
    element(el: Element) {
      el.setAttribute('content', value)
    },
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function rewriteOg(resp: Response, r: Rewrite): Response {
  const title = escapeAttr(r.title)
  const desc = escapeAttr(r.description)
  const img = escapeAttr(r.imageUrl)

  const extra = [
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${title}" />`,
  ].join('\n    ')

  return new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(r.title)
      },
    })
    .on('meta[property="og:title"]', setContent(r.title))
    .on('meta[property="og:description"]', setContent(r.description))
    .on('meta[property="og:image"]', setContent(r.imageUrl))
    .on('meta[property="og:url"]', setContent(r.pageUrl))
    .on('head', {
      element(el) {
        el.append('\n    ' + extra + '\n  ', { html: true })
      },
    })
    .transform(resp)
}
