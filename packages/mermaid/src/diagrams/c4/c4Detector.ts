import type {
  DiagramDetector,
  DiagramLoader,
  ExternalDiagramDefinition,
} from '../../diagram-api/types.js';

const id = 'c4';

const detector: DiagramDetector = (txt) => {
  // The keyword must open the diagram; anchoring only the first alternative let any diagram
  // that merely mentions, say, `C4Container` be taken for a C4 diagram.
  return /^\s*(?:C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/.test(txt);
};

const loader: DiagramLoader = async () => {
  const { diagram } = await import('./c4Diagram.js');
  return { id, diagram };
};

const plugin: ExternalDiagramDefinition = {
  id,
  detector,
  loader,
};

export default plugin;
