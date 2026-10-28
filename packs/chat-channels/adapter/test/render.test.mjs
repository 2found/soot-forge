import assert from 'node:assert/strict';
import test from 'node:test';
import {LIMITS, renderItem} from '../core/render.mjs';
import {outboxItems, response} from './helpers.mjs';

const copy = response('session', 'session: handshake').body.copy;
const items = Object.fromEntries(outboxItems().map(item => [item.receipt_id, item]));

test('reply: bold and nest:// link become HTML with the object label, never the raw link', () => {
  const {text, buttons} = renderItem(items.ob_7Q2mKx81Ra, {platform: 'telegram', copy});
  assert.equal(text, 'Hôm nay cả đội dùng <b>182.400 token</b>. Soot CSKH dùng nhiều nhất (121.000), còn dưới ngân sách 200.000/ngày.');
  assert.deepEqual(buttons, []);
  assert.doesNotMatch(renderItem(items.ob_1Mb6Yd90Hg, {platform: 'discord', copy}).text, /nest:\/\//);
});

test('a nest:// link with a Nest web url is linked; unknown nest:// link is its label; http stays a link', () => {
  const item = {kind: 'reply', text: '[A](nest://soot/a) [B](nest://soot/b) [C](https://shop.example/c) nest://soot/a',
    links: [{href: 'nest://soot/a', label: 'Soot A', url: 'https://nest.example/soot/a'}]};
  assert.equal(renderItem(item, {platform: 'telegram', copy}).text,
    '<a href="https://nest.example/soot/a">Soot A</a> B <a href="https://shop.example/c">C</a> Soot A');
  assert.equal(renderItem(item, {platform: 'discord', copy}).text,
    '[Soot A](<https://nest.example/soot/a>) B [C](<https://shop.example/c>) Soot A');
});

test('everything outside the subset is escaped', () => {
  const item = {kind: 'reply', text: '<script>a & b</script> @everyone *x* _y_ `z<`\n# not a heading\n- item'};
  assert.equal(renderItem(item, {platform: 'telegram', copy}).text,
    '&lt;script&gt;a &amp; b&lt;/script&gt; @everyone <i>x</i> <i>y</i> <code>z&lt;</code>\n# not a heading\n• item');
  assert.equal(renderItem(item, {platform: 'discord', copy}).text,
    '\\<script\\>a & b\\</script\\> @everyone _x_ _y_ `z<`\n\\# not a heading\n• item');
});

test('attention: token → callback button, url → link button, neither → plain line; diff in a code block', () => {
  const approval = renderItem(items.ob_9Vb3Tt20Qc, {platform: 'telegram', copy});
  assert.deepEqual(approval.buttons.map(button => [button.label, button.token]), [['Duyệt và chạy', 'k7Hq2Lm9Ap0Zx4'], ['Từ chối', 'r3Dw8Ns1Bv6Yt2']]);
  const unknown = renderItem(items.ob_5Kc0Wm33Jd, {platform: 'telegram', copy});
  assert.deepEqual(unknown.buttons, []);
  assert.match(unknown.text, /\n\n→ Mở Nest → Cần bạn để kiểm tra$/);
  const improve = renderItem(items.ob_2Hn8Pq71Ue, {platform: 'discord', copy});
  assert.match(improve.text, /```\n--- skills\/cskh\.md[\s\S]*\n```$/);
  const link = renderItem({kind: 'attention', text: 'x', attention: {choices: [{label: 'Mở', url: 'https://nest.example/a'}]}}, {platform: 'telegram', copy});
  assert.deepEqual(link.buttons, [{label: 'Mở', style: undefined, url: 'https://nest.example/a'}]);
});

for (const platform of ['telegram', 'discord']) {
  test(`${platform}: long text is cut at a sentence, never split, and ends with truncated + open_url`, () => {
    const sentence = 'Hôm qua đội làm rất nhiều việc quan trọng cho shop. ';
    const item = {...items.ob_4Tg7Ub22Lj, text: 'Mở đầu ngắn.\n\n' + sentence.repeat(200)};
    const {text} = renderItem(item, {platform, copy});
    assert.ok(text.length <= LIMITS[platform], `${text.length}`);
    assert.ok(text.includes(copy.truncated));
    assert.ok(text.includes('https://nest.shop.example/chat/c/9f3a1c7e2b'));
    assert.match(text.split('\n\n' + (platform === 'telegram' ? '' : '') + copy.truncated)[0], /\.$/);
  });
}

test('without open_url the suffix is copy.open_in_nest; a single huge word is hard-cut', () => {
  const {text} = renderItem({kind: 'reply', text: 'x'.repeat(5000), open_url: null}, {platform: 'telegram', copy});
  assert.ok(text.length <= 4096);
  assert.ok(text.endsWith(`${copy.truncated}\n${copy.open_in_nest}`));
});
