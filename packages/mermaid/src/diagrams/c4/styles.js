import { getConfig } from '../../diagram-api/diagramAPI.js';
import { C4_ELEMENT_TYPES } from './c4ShapeAdapter.js';

/**
 * Font rules from the c4 config: one per element type (`personFontFamily` and friends), one for
 * boundary titles (`boundaryFont*`) and one for relationship labels (`messageFont*`).
 * Built through the CSSOM so config values are parsed as CSS values: a value that does not fit
 * the property's grammar (e.g. one smuggling extra declarations) is dropped whole instead of
 * landing in the stylesheet.
 */
const fontStyles = () => {
  const c4 = getConfig().c4 ?? {};
  const sheet = new CSSStyleSheet();
  const addRule = (selector, prefix) => {
    const rule = sheet.cssRules[sheet.insertRule(`${selector} {}`, sheet.cssRules.length)];
    const fontFamily = c4[`${prefix}FontFamily`];
    const fontSize = c4[`${prefix}FontSize`];
    const fontWeight = c4[`${prefix}FontWeight`];
    if (fontFamily) {
      rule.style.setProperty('font-family', fontFamily);
    }
    if (fontSize) {
      rule.style.setProperty(
        'font-size',
        typeof fontSize === 'number' ? `${fontSize}px` : fontSize
      );
    }
    if (fontWeight) {
      rule.style.setProperty('font-weight', String(fontWeight));
    }
  };
  for (const type of C4_ELEMENT_TYPES) {
    addRule(`.c4-shape.c4-${type} .label`, type);
  }
  addRule('.c4-boundary-title .label', 'boundary');
  addRule('.c4-rel-label .label', 'message');
  return [...sheet.cssRules]
    .filter((rule) => rule.style.length > 0)
    .map((rule) => `  ${rule.cssText}`)
    .join('\n');
};

const getStyles = (options) => {
  const text = options.textColor ?? '#333333';
  const background = options.background ?? '#ffffff';
  // Relationship lines and boundary frames: a neutral grey that reads on light and dark
  // backgrounds alike, so a theme never leaves them invisible.
  const line = '#888888';
  return `
${fontStyles()}

  /* The element font colour is set inline per element (default white); the
     label text takes it via currentColor. */
  .c4-shape .label,
  .c4-shape .label text {
    color: inherit;
    fill: currentColor;
  }
  /* Structurizr typography: bold name, smaller stereotype/type and description lines. */
  .c4-shape .label .c4-name {
    font-weight: bold;
  }
  .c4-shape .label .c4-type {
    font-size: 0.75em;
  }
  .c4-shape .label .c4-descr {
    font-size: 0.82em;
  }
  .c4-shape .basic,
  .c4-shape rect,
  .c4-shape path,
  .c4-shape circle,
  .c4-shape ellipse,
  .c4-shape line {
    stroke-width: 2px;
  }

  /* Boundaries: a dashed frame with the title in its top-left corner. Deployment
     nodes are solid, as in the C4 model. */
  .c4-boundary-frame {
    fill: none;
    stroke: ${line};
    stroke-width: 1px;
    stroke-dasharray: 7 5;
  }
  .c4-deployment-node > .c4-boundary-frame {
    stroke-dasharray: none;
  }
  .c4-boundary-title .label {
    color: ${text};
  }
  .c4-boundary-title .label text {
    fill: currentColor;
  }
  .c4-boundary-title .label .c4-name {
    font-weight: bold;
  }
  .c4-boundary-title-bg {
    fill: ${background};
    stroke: none;
  }
  .c4-boundary-title .label .c4-type,
  .c4-boundary-title .label .c4-descr {
    font-size: 0.82em;
  }

  /* Relationships: a thin line with an arrowhead, and a label on an opaque
     background so it stays legible where it sits on its own line. */
  .c4-relationships path.c4-rel {
    stroke: ${line};
    stroke-width: 1.2px;
    fill: none;
  }
  .marker.c4 {
    fill: ${line};
    stroke: ${line};
  }
  .c4-rel-label .label {
    color: ${text};
  }
  .c4-rel-label .label text {
    fill: currentColor;
  }
  .c4-rel-label .label .c4-type {
    font-style: italic;
    font-size: 0.9em;
  }
  .c4-rel-label .label .c4-descr {
    font-size: 0.9em;
  }
  .c4-rel-label-bg {
    fill: ${background};
    stroke: none;
  }

  .c4TitleText {
    text-anchor: middle;
    font-size: 18px;
    font-weight: bold;
    fill: ${options.titleColor ?? text};
  }
`;
};

export default getStyles;
