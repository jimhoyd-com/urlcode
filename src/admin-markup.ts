import {escapeHtml} from '@jimhoyd/urlcode-ui';
import {csrfField} from '@jimhoyd/urlcode-auth';
/** Shared admin form fragments; callers pass already-resolved (untranslated-source) labels. */
export const hidden=(name:string,value:string)=>`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
export const postForm=(action:string,csrf:string,fields:string,label:string,destructive=false)=>`<form class="ui-form-grid" method="post" action="${escapeHtml(action)}">${csrfField(csrf)}${fields}<div class="ui-actions"><button${destructive?' class="ui-button-destructive"':''} type="submit">${escapeHtml(label)}</button></div></form>`;
