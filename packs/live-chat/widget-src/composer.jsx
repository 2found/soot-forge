import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Select} from '@tofound/ui';
import {AgentComposer} from '@tofound/ui/agent';

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
    toolbar={<>{props.scopes?.length>1?<Select size="small" variant="borderless" className="widget-scope-trigger" popupClassName="widget-scope-menu" aria-label={props.scopeLabel||'Working scope'} value={props.scopeValue||undefined} disabled={props.scopeDisabled} placeholder={props.scopePlaceholder||'Choose scope'} options={props.scopes} onChange={props.onScope}/>:<span className="widget-composer-name">{props.scopeName||props.name || 'Soot'}</span>}</>}
    footer={<span id="composer-hint">{props.hint || 'Enter để gửi · Shift + Enter để xuống dòng · Esc hai lần xóa text'}</span>}
    completions={{files:props.files || [],skillLabel:props.skillLabel || 'Kỹ năng',fileLabel:props.fileLabel || 'Tệp đã chia sẻ',emptyLabel:props.emptyLabel || 'Chưa có mục phù hợp trong phiên này.'}}
  />));
  render();
  return {setValue(next){value=next;render();},update(next){props={...props,...next};render();},destroy(){root.unmount();}};
}
