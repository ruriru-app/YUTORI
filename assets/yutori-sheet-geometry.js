(function (root) {
  "use strict";
  const validSize = size => !!size && [size.width, size.height].every(value => Number.isFinite(value) && value > 0);
  function validRect(rect, normalized = false) {
    return !!rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
      rect.left >= 0 && rect.top >= 0 && rect.right > rect.left && rect.bottom > rect.top &&
      (!normalized || (rect.right <= 1 && rect.bottom <= 1));
  }
  function headerTransform(reference, header, imageSize) {
    if (!validSize(reference?.paper) || !validRect(reference.headerMm) || !validRect(header, true) || !validSize(imageSize)) return null;
    const physical = reference.headerMm;
    // A long edge is a more stable ruler than the short header height on scanned pages.
    const pxPerMm = (header.right - header.left) * imageSize.width / (physical.right - physical.left);
    const heightRatio = (header.bottom - header.top) * imageSize.height / ((physical.bottom - physical.top) * pxPerMm);
    if (heightRatio < .7 || heightRatio > 1.3) return null;
    return { pxPerMm, x: header.left * imageSize.width - physical.left * pxPerMm, y: header.top * imageSize.height - physical.top * pxPerMm };
  }
  function mapReferenceRect(rectMm, reference, header, imageSize) {
    const transform = headerTransform(reference, header, imageSize);
    if (!transform || !validRect(rectMm)) return null;
    const rect = {
      left: Math.max(0, (transform.x + rectMm.left * transform.pxPerMm) / imageSize.width),
      top: Math.max(0, (transform.y + rectMm.top * transform.pxPerMm) / imageSize.height),
      right: Math.min(1, (transform.x + rectMm.right * transform.pxPerMm) / imageSize.width),
      bottom: Math.min(1, (transform.y + rectMm.bottom * transform.pxPerMm) / imageSize.height)
    };
    return validRect(rect, true) ? rect : null;
  }
  function predictFromHeader(reference, header, imageSize) {
    const transform = headerTransform(reference, header, imageSize);
    const grid = mapReferenceRect(reference?.gridMm, reference, header, imageSize);
    return transform && grid ? { grid, header: { ...header }, pxPerMm: transform.pxPerMm } : null;
  }
  function questionRect(grid, test, q) {
    const rows = Number(test?.rows) || 10, cols = Number(test?.cols) || 3;
    if (!validRect(grid, true) || !Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1 || !Number.isInteger(q) || q < 0 || q >= rows * cols) return null;
    const column = test.flow === "row" ? q % cols : Math.floor(q / rows), row = test.flow === "row" ? Math.floor(q / cols) : q % rows;
    const width = (grid.right - grid.left) / cols, height = (grid.bottom - grid.top) / rows;
    return { left: grid.left + column * width, top: grid.top + row * height, width, height };
  }
  root.YutoriSheetGeometry = Object.freeze({ predictFromHeader, mapReferenceRect, questionRect, validRect });
})(globalThis);
