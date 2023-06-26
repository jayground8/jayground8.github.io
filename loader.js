export default function myImageLoader({ src, width, quality }) {
  return `https://jayground8.github.io/static/images/${src}?w=${width}&q=${quality || 75}`
}
