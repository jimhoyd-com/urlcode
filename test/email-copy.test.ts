import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailCopy, englishEmailCatalogue } from '../src/email-copy.ts';
import { createSesSender } from '../src/senders.ts';
test('email catalogues preserve required links and codes, select locale and snapshot operator copy',()=>{
    const source={fr:{'signup-code':{subject:'Vérifiez votre adresse',text:'Code : {code}\nReprenez : {link}'}}};
    const copy=createEmailCopy({defaultLocale:'en',catalogues:source});source.fr['signup-code'].text='MUTATED';
    assert.deepEqual(copy.render('signup-code',{code:'123456',link:'https://example.test/account/signup'},'fr-CA'),{subject:'Vérifiez votre adresse',text:'Code : 123456\nReprenez : https://example.test/account/signup'});
    assert.equal(copy.render('new-device',{link:'https://example.test/account'},'fr').subject,englishEmailCatalogue['new-device'].subject);
    for(const template of [{subject:'x\nBcc: other',text:'{code} {link}'},{subject:'Code',text:'Missing proof link {code}'},{subject:'Code',text:'{code} {link} {unknown}'}])assert.throws(()=>createEmailCopy({catalogues:{fr:{'signup-code':template}}}));
    assert.throws(()=>copy.render('signup-code',{code:'123456'},'fr'));
    assert.throws(()=>createEmailCopy({defaultLocale:'bad_locale'}));
});
test('SES sends localized plain text while proof URL construction stays fixed to operator origin',async()=>{
    let sent:unknown;
    const emailCopy=createEmailCopy({defaultLocale:'fr',catalogues:{fr:{'reset-password':{subject:'Réinitialisez',text:'Ouvrez {link} sans partager ce lien.'}}}});
    const sender=createSesSender({origin:'https://accounts.example.test',authMount:'/account',region:'us-east-1',from:'operator@example.test',emailCopy,transport:async command=>{sent=command.input;}});
    await sender({email:'user@example.test',token:'a'.repeat(43),purpose:'reset-password',signal:new AbortController().signal});
    const encoded=JSON.stringify(sent);assert.ok(encoded.includes('Réinitialisez'));assert.ok(encoded.includes('https://accounts.example.test/account/reset?token='));assert.ok(!encoded.includes('"Html"'));
    sender.close();
});
