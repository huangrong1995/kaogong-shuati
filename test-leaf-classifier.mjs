import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLeaf } from './lib/leaf-classifier.mjs';

test('图推细分标签：笔画数命中最优先', () => {
  assert.equal(classifyLeaf({ sub: '图形推理', content: '从所给四个选项中，选择最合适填入问号处', analysis: '题干图形均为一笔画图形，奇点数为0，故选…' }), '笔画数');
});
test('图推：对称性', () => assert.equal(classifyLeaf({ sub: '图形推理', analysis: '题干图形均为轴对称图形，对称轴依次顺时针旋转' }), '对称性'));
test('图推：空间类六面体', () => assert.equal(classifyLeaf({ sub: '图形推理', analysis: '展开图折叠后，面1与面3相对' }), '六面体'));
test('图推：未命中归未细分', () => assert.equal(classifyLeaf({ sub: '图形推理', content: 'x', analysis: '不知所谓' }), '未细分'));
test('资料分析·增长', () => assert.equal(classifyLeaf({ sub: '增长', content: '2020年…同比增长…', analysis: '现期量=3553，增长率=15.3%' }), '增长率'));
test('资料分析·比重', () => assert.equal(classifyLeaf({ sub: '比重', analysis: '…占…的比重为48.6%，基期比重…' }), '基期比重'));
test('言语·逻辑填空回退 FENBI 叶子', () => assert.equal(classifyLeaf({ sub: '逻辑填空', analysis: '“望尘莫及”为成语，与语境搭配…' }), '成语填空'));
test('逻辑判断回退 FENBI 叶子', () => assert.equal(classifyLeaf({ sub: '逻辑判断', analysis: '最能削弱上述论证的选项是…' }), '削弱题型'));
test('缺解析/空文本不抛错', () => { classifyLeaf({ sub: '图形推理' }); classifyLeaf({}); assert.equal(classifyLeaf({ sub: '图形推理', analysis: '' }), '未细分'); });