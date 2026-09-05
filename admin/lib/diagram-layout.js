export const HEADER = 56, ROW = 28;
export const nodeId = id => `t${id}`;
export const edgeId = id => `fk${id}`;
export function buildDiagramGraph(model) {
  return {
    id: 'database',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=48,left=48,bottom=48,right=48]',
      'elk.spacing.nodeNode': '65', 'elk.layered.spacing.nodeNodeBetweenLayers': '140',
      'elk.spacing.edgeNode': '24', 'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.spacing.componentComponent': '85', 'elk.separateConnectedComponents': 'true',
    },
    children: model.tables.map(t => {
      const width = Math.max(400, Math.min(600, Math.max(t.schema.length + t.name.length + 2,
        ...t.columns.map(c => Math.min(c.name.length, 30) + Math.min(c.sqlType.length, 25) + 15)) * 7.5));
      return { id: nodeId(t.id), width, height: HEADER + ROW * t.columns.length + 8,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: t.columns.flatMap((c, i) => ['in', 'out'].map(side => ({
          id: `${nodeId(t.id)}:${c.id}:${side}`, width: 0, height: 0,
          x: side === 'in' ? 0 : width, y: HEADER + i * ROW + ROW / 2,
          layoutOptions: { 'elk.port.side': side === 'in' ? 'WEST' : 'EAST' },
        }))),
      };
    }),
    edges: model.foreignKeys.map(fk => ({
      id: edgeId(fk.id),
      sources: [`${nodeId(fk.parentTableId)}:${fk.columns[0].parentColumnId}:out`],
      targets: [`${nodeId(fk.childTableId)}:${fk.columns[0].childColumnId}:in`],
      labels: [{ id: `label${fk.id}`, text: `${fk.optional ? '0..1' : '1'} : ${fk.childUnique ? '0..1' : 'N'}`, width: 82, height: 22 }],
    })),
  };
}
