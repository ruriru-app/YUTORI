(function (root) {
  "use strict";
  const validSize = size => !!size && [size.width, size.height].every(value => Number.isFinite(value) && value > 0);
  const validExtent = rect => !!rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) && rect.right > rect.left && rect.bottom > rect.top;
  function validRect(rect, normalized = false) {
    return validExtent(rect) && rect.left >= 0 && rect.top >= 0 &&
      (!normalized || (rect.right <= 1 && rect.bottom <= 1));
  }
  function clipRect(rect) {
    if (!validExtent(rect)) return null;
    const visible = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(1, rect.right), bottom: Math.min(1, rect.bottom) };
    return validRect(visible, true) ? visible : null;
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
  function mapReferenceExtent(rectMm, reference, header, imageSize) {
    const transform = headerTransform(reference, header, imageSize);
    if (!transform || !validRect(rectMm)) return null;
    const rect = {
      left: (transform.x + rectMm.left * transform.pxPerMm) / imageSize.width,
      top: (transform.y + rectMm.top * transform.pxPerMm) / imageSize.height,
      right: (transform.x + rectMm.right * transform.pxPerMm) / imageSize.width,
      bottom: (transform.y + rectMm.bottom * transform.pxPerMm) / imageSize.height
    };
    return validExtent(rect) ? rect : null;
  }
  function mapReferenceRect(rectMm, reference, header, imageSize) {
    return clipRect(mapReferenceExtent(rectMm, reference, header, imageSize));
  }
  function predictFromHeader(reference, header, imageSize) {
    const transform = headerTransform(reference, header, imageSize);
    // The model must retain its full extent: clipping before subdivision moves
    // rows/columns into their neighbors when part of the paper is off-image.
    const grid = mapReferenceExtent(reference?.gridMm, reference, header, imageSize);
    return transform && grid ? { grid, visibleGrid: clipRect(grid), header: { ...header }, pxPerMm: transform.pxPerMm } : null;
  }
  function questionRect(grid, test, q) {
    const rows = Number(test?.rows) || 10, cols = Number(test?.cols) || 3;
    if (!validExtent(grid) || !Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1 || !Number.isInteger(q) || q < 0 || q >= rows * cols) return null;
    const column = test.flow === "row" ? q % cols : Math.floor(q / rows), row = test.flow === "row" ? Math.floor(q / cols) : q % rows;
    const width = (grid.right - grid.left) / cols, height = (grid.bottom - grid.top) / rows;
    return { left: grid.left + column * width, top: grid.top + row * height, width, height };
  }
  root.YutoriSheetGeometry = Object.freeze({ predictFromHeader, mapReferenceRect, questionRect, validRect, clipRect });
})(globalThis);
