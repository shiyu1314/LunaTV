import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatRequest {
  messages: OpenAIMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    
    // 检查用户权限
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const username = authInfo.username;
    
    // 获取配置检查AI功能是否启用
    const adminConfig = await getConfig();
    const aiConfig = adminConfig.AIRecommendConfig;
    
    if (!aiConfig?.enabled) {
      return NextResponse.json({ 
        error: 'AI推荐功能未启用' 
      }, { status: 403 });
    }

    // 检查API配置是否完整
    if (!aiConfig.apiKey || !aiConfig.apiUrl) {
      return NextResponse.json({ 
        error: 'AI推荐功能配置不完整，请联系管理员' 
      }, { status: 500 });
    }

    const { messages, model, temperature, max_tokens } = await request.json() as ChatRequest;

    // 验证请求格式
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ 
        error: 'Invalid messages format' 
      }, { status: 400 });
    }

    // 优化缓存策略 - 只对简单的单轮问答进行短时缓存
    let cacheKey: string | null = null;
    let cachedResponse = null;
    
    // 只有在单轮对话且消息较短时才使用缓存，避免过度缓存复杂对话
    if (messages.length === 1 && messages[0].role === 'user' && messages[0].content.length < 50) {
      const questionHash = Buffer.from(messages[0].content.trim().toLowerCase()).toString('base64').slice(0, 16);
      cacheKey = `ai-recommend-simple-${questionHash}`;
      cachedResponse = await db.getCache(cacheKey);
    }
    
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    // 结合当前日期的结构化推荐系统提示词
    const currentDate = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const randomElements = [
      '尝试推荐一些不同类型的作品',
      '可以包含一些经典和新作品的混合推荐', 
      '考虑推荐一些口碑很好的作品',
      '可以推荐一些最近讨论度比较高的作品'
    ];
    const randomHint = randomElements[Math.floor(Math.random() * randomElements.length)];
    
    const systemPrompt = `你是LunaTV的智能推荐助手，专门帮助用户发现优质的影视内容。当前日期：${currentDate}

你的回复必须遵循以下步骤：
1. 首先用自然语言简单回应用户的需求。
2. 然后，另起一行，开始提供具体的影片推荐列表。
3. 如果用户的聊天内容跟获取影视推荐方面无关，直接拒绝回答！
4. 对于推荐列表中的每一部影片，你必须严格按照以下格式提供，不得有任何偏差：
《片名》 (年份) [类型] - 简短描述

推荐要求：
- ${randomHint}
- 重点推荐${currentYear}年的最新作品
- 可以包含${lastYear}年的热门作品
- 避免推荐${currentYear-2}年以前的老作品，除非是经典必看
- 推荐内容要具体，包含作品名称、年份、类型、推荐理由
- 每次回复尽量提供一些新的角度或不同的推荐
- 避免推荐过于小众或难以找到的内容

格式限制：
- 严禁输出任何Markdown格式。
- "片名"必须是真实存在的影视作品的官方全名。
- "年份"必须是4位数字的公元年份。
- "类型"必须是该影片的主要类型，例如：剧情/悬疑/科幻。
- "简短描述"是对影片的简要介绍。
- 每一部推荐的影片都必须独占一行，并以《》开始。

格式示例（注意：优先推荐${currentYear}-${lastYear}年作品）：
《示例作品1》 (${currentYear}) [类型] - 简短描述。
《示例作品2》 (${lastYear}) [类型] - 简短描述。

请始终保持专业和有用的态度，为用户提供最佳的影视推荐体验。`;

    // 准备发送给OpenAI的消息
    const chatMessages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // 使用配置中的参数或请求参数
    const requestBody = {
      model: model || aiConfig.model,
      messages: chatMessages,
      temperature: temperature ?? aiConfig.temperature,
      max_tokens: max_tokens ?? aiConfig.maxTokens,
    };

    // 调用AI API
    const openaiResponse = await fetch(aiConfig.apiUrl.endsWith('/chat/completions') 
      ? aiConfig.apiUrl 
      : `${aiConfig.apiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.text();
      console.error('OpenAI API Error:', errorData);
      return NextResponse.json({ 
        error: 'AI服务暂时不可用，请稍后重试' 
      }, { status: 500 });
    }

    const aiResult = await openaiResponse.json();
    const aiContent = aiResult.choices?.[0]?.message?.content || '抱歉，我现在无法提供推荐，请稍后重试。';
    
    // 提取结构化推荐信息
    const recommendations = extractRecommendations(aiContent);
    
    // 构建返回格式
    const response = {
      id: aiResult.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: aiResult.created || Math.floor(Date.now() / 1000),
      model: aiResult.model || requestBody.model,
      choices: aiResult.choices || [{
        index: 0,
        message: {
          role: 'assistant',
          content: aiContent
        },
        finish_reason: aiResult.choices?.[0]?.finish_reason || 'stop'
      }],
      usage: aiResult.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      recommendations: recommendations // 添加结构化推荐数据
    };

    // 缓存结果（只对简单问题进行短时缓存，15分钟）
    if (cacheKey) {
      await db.setCache(cacheKey, response, 900); // 15分钟缓存
    }

    // 记录用户AI推荐历史（可选）
    try {
      const historyKey = `ai-recommend-history-${username}`;
      const existingHistory = await db.getCache(historyKey) || [];
      const newHistory = [
        {
          timestamp: new Date().toISOString(),
          messages: messages.slice(-1), // 只保存用户最后一条消息
          response: response.choices[0].message.content
        },
        ...existingHistory.slice(0, 9) // 保留最近10条记录
      ];
      await db.setCache(historyKey, newHistory, 7 * 24 * 3600); // 缓存一周
    } catch (error) {
      console.warn('保存AI推荐历史失败:', error);
    }

    return NextResponse.json(response);

  } catch (error) {
    console.error('AI推荐API错误:', error);
    return NextResponse.json({ 
      error: '服务器内部错误' 
    }, { status: 500 });
  }
}

// 获取AI推荐历史
export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const username = authInfo.username;
    const historyKey = `ai-recommend-history-${username}`;
    const history = await db.getCache(historyKey) || [];

    return NextResponse.json({
      history: history,
      total: history.length
    });

  } catch (error) {
    console.error('获取AI推荐历史错误:', error);
    return NextResponse.json({ 
      error: '获取历史记录失败' 
    }, { status: 500 });
  }
}

// 从AI回复中提取推荐信息的辅助函数
function extractRecommendations(content: string) {
  const recommendations = [];
  const moviePattern = /《([^》]+)》\s*\((\d{4})\)\s*\[([^\]]+)\]\s*-\s*(.*)/;
  const lines = content.split('\n');

  for (const line of lines) {
    if (recommendations.length >= 4) {
      break;
    }
    const match = line.match(moviePattern);
    if (match) {
      const [, title, year, genre, description] = match;
      recommendations.push({
        title: title.trim(),
        year: year.trim(),
        genre: genre.trim(),
        description: description.trim() || 'AI推荐影片',
      });
    }
  }
  return recommendations;
}