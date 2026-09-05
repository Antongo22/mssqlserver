import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
const textarea = document.getElementById('sql-editor');
const language = new Compartment();
const host = document.createElement('div');
host.id = 'code-editor'; textarea.after(host); textarea.hidden = true;
const editor = new EditorView({
  parent: host,
  state: EditorState.create({doc: textarea.value, extensions: [
    lineNumbers(), history(), drawSelection(), highlightActiveLine(),
    language.of(sql({ dialect: MSSQL, upperCaseKeywords: true })), autocompletion(),
    keymap.of([{ key: 'Mod-Enter', run: () => { document.getElementById('run-query').click(); return true; } }, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of(update => { if (update.docChanged) { textarea.value = update.state.doc.toString(); textarea.dispatchEvent(new Event('input')); } }),
    EditorView.contentAttributes.of({ 'aria-label': 'SQL-запрос', spellcheck: 'false' }),
    EditorView.theme({ '&': { fontSize: '14px' }, '.cm-scroller': { fontFamily: 'SFMono-Regular,Consolas,monospace', minHeight: '260px', maxHeight: '600px', overflow: 'auto' }, '.cm-content': { padding: '16px 0' }, '.cm-gutters': { backgroundColor: '#f8fafc', color: '#8b9bb4', borderRight: '1px solid #e1e7f0' }, '.cm-activeLine': { backgroundColor: '#edf2ff80' } }),
  ]}),
});
window.sqlEditor = {
  getValue: () => editor.state.doc.toString(),
  getSelection: () => editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
  setValue: text => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }),
  focus: () => editor.focus(),
  setSchema: schema => editor.dispatch({ effects: language.reconfigure(sql({ dialect: MSSQL, schema, upperCaseKeywords: true })) }),
};
