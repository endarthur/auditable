// Font metrics via Canvas measureText

const _metricsCanvas = document.createElement('canvas');
const _metricsCtx = _metricsCanvas.getContext('2d');

function createMetrics(family, size, style) {
  const font = (style ? style + ' ' : '') + size + 'pt ' + family;
  _metricsCtx.font = font;

  const spaceWidth = _metricsCtx.measureText(' ').width;
  const emWidth = _metricsCtx.measureText('M').width;

  return {
    font,
    family,
    size,
    style: style || '',
    spaceWidth,
    emWidth,
    measure(text) {
      _metricsCtx.font = font;
      return _metricsCtx.measureText(text).width;
    },
  };
}

export { createMetrics };
