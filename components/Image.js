import NextImage from 'next/image'

const imageLoader = ({ src, width, quality }) => {
  return `https://jayground8.github.io/static/images/${src}?w=${width}&q=${quality || 75}`
}

// eslint-disable-next-line jsx-a11y/alt-text
const Image = ({ ...rest }) => <NextImage loader={imageLoader} {...rest} />

export default Image
