import * as code from './vscode';
export default class ProtocolCompletionItem extends code.CompletionItem {
  data: any;
  fromEdit: boolean;
  constructor(label: string);
}
