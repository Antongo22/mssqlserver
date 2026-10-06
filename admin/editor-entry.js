import { EditorState, Compartment } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { classHighlighter } from '@lezer/highlight';
import { joinCompletion } from './lib/join-completion.js';
let relationalModel;
const textarea = document.getElementById('sql-editor');
const language = new Compartment();
const appearance = new Compartment();
const editorTheme = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  return EditorView.theme({
  '&': { fontSize: '14px', color: 'var(--ink)', backgroundColor: 'var(--surface)' },
  '.cm-scroller': { fontFamily: 'SFMono-Regular,Consolas,monospace', minHeight: '260px', maxHeight: '600px', overflow: 'auto' },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-subtle)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--blue-soft)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--action)', color: '#fff' },
  '.tok-keyword': { color: dark ? '#569cd6' : '#0000ff', fontWeight: '600' },
  '.tok-string, .tok-string2': { color: dark ? '#ce9178' : '#a31515' },
  '.tok-number, .tok-literal': { color: dark ? '#b5cea8' : '#098658' },
  '.tok-comment': { color: dark ? '#6a9955' : '#008000', fontStyle: 'italic' },
  '.tok-typeName': { color: dark ? '#4ec9b0' : '#267f99' },
  '.tok-variableName, .tok-variableName2': { color: dark ? '#9cdcfe' : '#001080' },
  '.tok-bool, .tok-atom': { color: dark ? '#569cd6' : '#0000ff' },
  '.tok-operator, .tok-punctuation': { color: dark ? '#d4d4d4' : '#333333' },
  '.tok-invalid': { textDecoration: 'underline wavy #f44747' },
  }, { dark });
};
const host = document.createElement('div');
host.id = 'code-editor'; textarea.after(host); textarea.hidden = true;
const editor = new EditorView({
  parent: host,
  state: EditorState.create({doc: textarea.value, extensions: [
    lineNumbers(), history(), drawSelection(), highlightActiveLine(),
    language.of(sql({ dialect: MSSQL, upperCaseKeywords: true })), syntaxHighlighting(classHighlighter), autocompletion(),
    MSSQL.language.data.of({ autocomplete: context => joinCompletion(context, relationalModel) }),
    keymap.of([{ key: 'Mod-Enter', run: () => { document.getElementById('run-query').click(); return true; } }, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of(update => { if (update.docChanged) { textarea.value = update.state.doc.toString(); textarea.dispatchEvent(new Event('input')); } }),
    EditorView.contentAttributes.of({ 'aria-label': 'SQL-запрос', spellcheck: 'false' }),
    appearance.of(editorTheme()),
  ]}),
});
document.addEventListener('studio-theme-change', () => editor.dispatch({ effects: appearance.reconfigure(editorTheme()) }));
window.sqlEditor = {
  setRelations: model => { relationalModel = model; },
  getValue: () => editor.state.doc.toString(),
  getSelection: () => editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
  setValue: text => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }),
  focus: () => editor.focus(),
  setSchema: schema => editor.dispatch({ effects: language.reconfigure(sql({ dialect: MSSQL, schema, defaultSchema: 'dbo', upperCaseKeywords: true })) }),
};
