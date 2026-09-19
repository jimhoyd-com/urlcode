import test from 'node:test';
import assert from 'node:assert/strict';
import {icon,button,navigation} from '../src/index.ts';
import type {IconName} from '../src/index.ts';
test('decorative icons preserve visible escaped labels and reject caller markup',()=>{
 const markup=button('Continue <now>','submit','arrow-right');
 assert.match(markup,/aria-hidden="true" focusable="false"/);
 assert.match(markup,/Continue &lt;now&gt;/);
 assert.match(markup,/ui-icon-directional/);
 assert.doesNotMatch(markup,/<title|aria-label|tabindex|<script/);
 assert.match(navigation([{label:'People',href:'/people',current:true,icon:'users'}]),/aria-current="page"/);
 assert.match(navigation([{label:'People',href:'/people',icon:'users'}]),/<\/svg>People<\/a>/);
 for(const name of ['__proto__','constructor','<script>alert(1)</script>','https://example.test/icon.svg'])assert.throws(()=>icon(name as IconName),/Unknown icon/);
 assert.equal(button('Save'),'<button data-slot="button" type="submit">Save</button>');
});
