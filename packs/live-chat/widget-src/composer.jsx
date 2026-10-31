import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Select} from '@tofound/ui';
import {AgentComposer, AgentQuestion} from '@tofound/ui/agent';

// A controlled React island. The existing frame owns transport, receipts and draft ACKs.
export function createWidgetComposer(container, onSend, onDraft) {
  const root=createRoot(container);
  let value='', props={};
  const render=()=>flushSync(()=>root.render(<AgentComposer
    id="text" value={value} onValueChange={next=>{value=next;render();onDraft(next);}}
    aria-label={props.message || 'Tin nhắn'} placeholder={props.placeholder || 'Nhắn tin…'}
    maxLength={4000} required autoSize={{minRows:1,maxRows:6}}
    disabled={props.disabled} readOnly={props.readOnly} sending={props.sending}
    canSend={props.canSend && !!value.trim()} onSend={onSend} sendLabel={props.sendLabel || 'Gửi tin nhắn'}
    enterToSend={props.mobile ? false : 'auto'}
    formProps={{'aria-busy':props.sending}}
    aria-invalid={props.invalid || undefined} aria-describedby={props.error ? 'error' : undefined}
    // A visitor only picks when there is a choice; one scope is already named in the header.
    toolbar={props.scopes?.length>1?<Select size="small" variant="borderless" className="widget-scope-trigger" popupClassName="widget-scope-menu" aria-label={props.scopeLabel||'Working scope'} value={props.scopeValue||undefined} disabled={props.scopeDisabled} placeholder={props.scopePlaceholder||'Choose scope'} options={props.scopes} onChange={props.onScope}/>:undefined}
    footer={<span id="composer-hint">{props.hint || 'Enter để gửi · Shift + Enter để xuống dòng · Esc hai lần xóa text'}</span>}
    completions={{files:props.files || [],skillLabel:props.skillLabel || 'Kỹ năng',fileLabel:props.fileLabel || 'Tệp đã chia sẻ',emptyLabel:props.emptyLabel || 'Chưa có mục phù hợp trong phiên này.'}}
  />));
  render();
  return {setValue(next){value=next;render();},update(next){props={...props,...next};render();},destroy(){root.unmount();}};
}

// A question card: the same 2ui AgentQuestion Nest uses, controlled by the frame.
// The frame owns the selection, the answer request and the receipt (spec §5.3).
export function createWidgetQuestion(container, initial) {
  const root=createRoot(container);
  let props=initial;
  const render=()=>flushSync(()=>root.render(<AgentQuestion
    title={props.title} prompt={props.prompt} options={props.options} value={props.value}
    onValueChange={props.onValueChange} onConfirm={props.onConfirm}
    confirmLabel={props.confirmLabel} selectionLabel={props.selectionLabel}
    multiple={props.multiple} busy={props.busy} answered={props.answered} footer={props.footer||undefined}
  />));
  render();
  return {update(next){props={...props,...next};render();},destroy(){root.unmount();}};
}
