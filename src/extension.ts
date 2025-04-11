import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';  // 添加axios用于API请求
import * as https from 'https';
import * as http from 'http';
import * as url from 'url';

const execAsync = promisify(exec);

// 添加常见编程语言和技术领域的关键词列表用于标签和分类识别
const TECH_KEYWORDS: Record<string, string[]> = {
  'js': ['javascript', 'js', 'es6', 'node', 'npm', 'vue', 'react', 'angular', 'webpack', 'typescript', 'ts'],
  'python': ['python', 'django', 'flask', 'numpy', 'pandas', 'pip'],
  'java': ['java', 'spring', 'maven', 'gradle'],
  'golang': ['go', 'golang'],
  'rust': ['rust', 'cargo'],
  'frontend': ['html', 'css', 'javascript', 'webpack', 'babel', 'sass', 'less', 'vue', 'react', 'angular'],
  'backend': ['api', 'rest', 'graphql', 'server', 'database', 'sql', 'nosql'],
  'database': ['mysql', 'mongodb', 'postgresql', 'redis', 'sql', 'nosql'],
  'devops': ['docker', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'jenkins'],
  'algorithm': ['algorithm', 'data structure', 'leetcode', 'complexity'],
  'mobile': ['android', 'ios', 'swift', 'kotlin', 'flutter', 'react native']
};

export function activate(context: vscode.ExtensionContext) {
  console.log('发布博客扩展已激活');

  // 注册命令
  const publishCommand = vscode.commands.registerCommand('publish-blog.publish', async (uriArg?: vscode.Uri | string) => {
    try {
      console.log('发布命令被调用，参数类型:', uriArg ? typeof uriArg : 'undefined');
      
      let uri: vscode.Uri | undefined;
      
      if (uriArg) {
        if (typeof uriArg === 'string') {
          try {
            uri = vscode.Uri.parse(uriArg);
            console.log('从字符串解析URI:', uri.fsPath);
          } catch (error) {
            console.error('解析URI字符串失败:', error);
          }
        } else {
          uri = uriArg;
          console.log('使用提供的URI对象:', uri.fsPath);
        }
      }
      
      if (!uri) {
        if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
          uri = vscode.window.activeTextEditor.document.uri;
          console.log('使用活动编辑器URI:', uri.fsPath);
        } else {
          const message = '请在 Markdown 文件上右键或使用文件列表中的发布按钮';
          console.log(message);
          vscode.window.showErrorMessage(message);
          return;
        }
      }

      await publishMarkdownFile(uri);
    } catch (error) {
      const message = `发布失败: ${error instanceof Error ? error.message : String(error)}`;
      console.error('发布错误:', error);
      vscode.window.showErrorMessage(message);
    }
  });

  context.subscriptions.push(publishCommand);

  // 注册带图标的发布命令（功能与publish相同）
  const publishWithIconCommand = vscode.commands.registerCommand('publish-blog.publishWithIcon', async (uri?: vscode.Uri) => {
    console.log('带图标的发布命令被调用:', uri?.fsPath);
    await vscode.commands.executeCommand('publish-blog.publish', uri);
  });
  
  context.subscriptions.push(publishWithIconCommand);

  // 添加右键菜单命令
  vscode.commands.executeCommand('setContext', 'markdown.fileOpen', true);

  // 为文件资源管理器中的 Markdown 文件添加发布按钮
  const markdownFileDecorationType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) => {
        if (uri.fsPath.endsWith('.md')) {
          return {
            badge: '📤',
            tooltip: '发布到博客'
          };
        }
        return null;
      }
    })
  );

  // 注册一个文件资源管理器点击命令，用于点击装饰图标时调用
  const fileExplorerClickCommand = vscode.commands.registerCommand('publish-blog.fileExplorerClick', async (uri?: vscode.Uri) => {
    if (uri && uri.fsPath.endsWith('.md')) {
      // 获取鼠标点击位置，检查是否在文件图标区域
      // 注意：这只是一个模拟，实际上VS Code API不直接提供这个信息
      console.log('文件资源管理器点击:', uri.fsPath);
      await vscode.commands.executeCommand('publish-blog.publish', uri);
    }
  });
  context.subscriptions.push(fileExplorerClickCommand);

  // 注册资源管理器项目点击事件 - 这需要一个自定义 TreeDataProvider
  const treeViewProvider = new MarkdownTreeDataProvider();
  const treeView = vscode.window.createTreeView('markdownExplorer', { 
    treeDataProvider: treeViewProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // 注册自定义视图到活动栏
  context.subscriptions.push(
    vscode.commands.registerCommand('publish-blog.refreshExplorer', () => {
      treeViewProvider.refresh();
    })
  );

  // 添加文件资源管理器视图中的悬停按钮
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'markdown', scheme: 'file' }, {
      provideHover: (document, position, token) => {
        const commandUri = vscode.Uri.file(document.fileName);
        return new vscode.Hover([
          '**发布到博客**',
          {
            language: 'markdown',
            value: '[点击发布](command:publish-blog.publish?' + encodeURIComponent(JSON.stringify([commandUri.toString()])) + ')'
          }
        ]);
      }
    })
  );
}

// 发布 Markdown 文件到博客仓库
async function publishMarkdownFile(fileUri: vscode.Uri): Promise<void> {
  // 获取博客仓库路径
  const config = vscode.workspace.getConfiguration('publishBlog');
  let blogRepoPath = config.get<string>('blogRepoPath');
  let blogDirPath = config.get<string>('blogDirPath') || '';

  // 如果未设置博客路径，请求用户设置
  if (!blogRepoPath) {
    const selectedPath = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择博客仓库文件夹'
    });

    if (!selectedPath || selectedPath.length === 0) {
      vscode.window.showErrorMessage('请选择博客仓库路径');
      return;
    }

    blogRepoPath = selectedPath[0].fsPath;
    await config.update('blogRepoPath', blogRepoPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`已设置博客仓库路径: ${blogRepoPath}`);
    
    // 可选：设置子目录
    const dirInput = await vscode.window.showInputBox({
      prompt: '博客仓库内的子目录（可选，如 posts 或 content/blog）',
      placeHolder: '留空则保存至根目录'
    });
    
    if (dirInput !== undefined) {
      blogDirPath = dirInput;
      await config.update('blogDirPath', blogDirPath, vscode.ConfigurationTarget.Global);
      if (blogDirPath) {
        vscode.window.showInformationMessage(`已设置博客子目录: ${blogDirPath}`);
      }
    }
  }

  // 确保博客仓库路径存在
  if (!fs.existsSync(blogRepoPath)) {
    vscode.window.showErrorMessage(`博客仓库路径不存在: ${blogRepoPath}`);
    return;
  }

  // 获取源文件路径和原始文件名
  const srcFilePath = fileUri.fsPath;
  const originalFileName = path.basename(srcFilePath);
  const fileExtension = path.extname(originalFileName);
  const fileNameWithoutExt = path.basename(originalFileName, fileExtension);
  
  // 弹出对话框让用户自定义文件名
  const customFileName = await vscode.window.showInputBox({
    title: '自定义博客文件名',
    prompt: '请输入要保存的文件名',
    placeHolder: '文件名（不含扩展名）',
    value: fileNameWithoutExt,
    ignoreFocusOut: true, // 防止点击其他地方时关闭
    validateInput: (text) => {
      // 验证文件名是否合法（不包含Windows/Linux/macOS文件系统中的非法字符）
      const invalidChars = /[\\/:*?"<>|]/g;
      return invalidChars.test(text) 
        ? '文件名不能包含以下字符: \\ / : * ? " < > |' 
        : null; // 返回null表示输入有效
    }
  });
  
  // 用户取消操作
  if (customFileName === undefined) {
    vscode.window.showInformationMessage('发布操作已取消');
    return;
  }
  
  // 构建最终文件名（确保添加原始扩展名）
  const finalFileName = customFileName + fileExtension;
  
  // 构建完整的目标路径，包含可能的子目录
  let targetDir = blogRepoPath;
  if (blogDirPath) {
    targetDir = path.join(blogRepoPath, blogDirPath);
    // 确保目标子目录存在
    await fs.ensureDir(targetDir);
  }
  
  // 读取原始文件内容
  const fileContent = await fs.readFile(srcFilePath, 'utf-8');
  
  // 处理内容，替换特定格式
  const processedContent = processMarkdownContent(fileContent);
  
  // 处理Markdown中的图片，迁移到专用文件夹
  const { updatedContent: contentWithImages, imageCount } = await processMarkdownImages(
    processedContent,
    srcFilePath,
    targetDir,
    finalFileName
  );
  
  // 检查内容是否已有frontMatter
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const hasFrontMatter = frontMatterRegex.test(contentWithImages);
  
  // 检查目标目录中是否存在内容相同的文件（不考虑顶部元信息）
  const existingFiles = await fs.readdir(targetDir);
  let existingFilePath: string | null = null;
  let existingFileName: string | null = null;
  
  console.log(`开始检查目标目录中是否存在内容相同的文件，共 ${existingFiles.length} 个文件待检查`);
  
  for (const file of existingFiles) {
    if (file.endsWith('.md')) {
      const filePath = path.join(targetDir, file);
      const fileStats = await fs.stat(filePath);
      
      // 跳过目录
      if (!fileStats.isFile()) {
        continue;
      }
      
      try {
        console.log(`检查文件: ${file}`);
        const existingContent = await fs.readFile(filePath, 'utf-8');
        
        // 去除文件开头的YAML Front Matter（元信息）
        const contentWithoutFrontMatter = existingContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
        
        // 获取当前处理文件的内容（去除可能的frontMatter）
        const currentContentWithoutFrontMatter = contentWithImages.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
        
        // 先比较长度，如果差异太大就跳过
        const lengthDifference = Math.abs(contentWithoutFrontMatter.length - currentContentWithoutFrontMatter.length);
        const lengthThreshold = currentContentWithoutFrontMatter.length * 0.05; // 允许5%的长度差异
        
        if (lengthDifference > lengthThreshold) {
          console.log(`文件 ${file} 长度差异过大，跳过`);
          continue;
        }
        
        // 比较处理后的内容是否一致
        if (contentWithoutFrontMatter === currentContentWithoutFrontMatter) {
          console.log(`找到内容相同的文件: ${file}`);
          existingFilePath = filePath;
          existingFileName = file;
          break;
        } else {
          // 检查是否只有微小差异（如空格、换行符）
          const normalizedExisting = contentWithoutFrontMatter.replace(/\s+/g, ' ').trim();
          const normalizedProcessed = currentContentWithoutFrontMatter.replace(/\s+/g, ' ').trim();
          
          if (normalizedExisting === normalizedProcessed) {
            console.log(`找到内容几乎相同的文件(仅空白字符差异): ${file}`);
            existingFilePath = filePath;
            existingFileName = file;
            break;
          }
        }
      } catch (err) {
        console.error(`读取文件 ${file} 失败:`, err);
        continue;
      }
    }
  }
  
  if (existingFilePath) {
    console.log(`将更新已存在的文件: ${existingFileName}`);
    
    // 询问用户是否要更新现有文件
    const updateChoice = await vscode.window.showQuickPick(
      [
        { label: `更新现有文件 (${existingFileName})`, value: 'update' },
        { label: `创建新文件 (${finalFileName})`, value: 'create' }
      ],
      {
        placeHolder: '检测到内容相同的文件，请选择操作',
        ignoreFocusOut: true
      }
    );
    
    if (!updateChoice) {
      vscode.window.showInformationMessage('操作已取消');
      return;
    }
    
    if (updateChoice.value === 'create') {
      existingFilePath = null;
      existingFileName = null;
      console.log(`用户选择创建新文件: ${finalFileName}`);
    } else {
      console.log(`用户选择更新现有文件: ${existingFileName}`);
    }
  } else {
    console.log(`未找到内容相同的文件，将创建新文件: ${finalFileName}`);
  }
  
  // 分析文件内容，提取可能的标签和分类
  const { tags, categories } = await analyzeContent(contentWithImages, customFileName);
  
  // 生成当前日期时间
  const now = new Date();
  const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  
  let newContent: string;
  
  if (hasFrontMatter) {
    // 更新现有的frontMatter
    console.log('检测到已有frontMatter，进行更新');
    
    // 提取和更新frontMatter内容
    newContent = contentWithImages.replace(frontMatterRegex, (match, frontMatterContent) => {
      // 解析现有frontMatter
      const lines = frontMatterContent.split('\n');
      const frontMatterObj: Record<string, string> = {};
      
      // 提取现有的键值对
      lines.forEach((line: string) => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          frontMatterObj[key] = value;
        }
      });
      
      // 更新需要更新的字段
      frontMatterObj['title'] = customFileName;
      frontMatterObj['date'] = formattedDate;
      frontMatterObj['tags'] = tags;
      frontMatterObj['categories'] = categories;
      
      // 重建frontMatter
      let updatedFrontMatter = '---\n';
      for (const [key, value] of Object.entries(frontMatterObj)) {
        updatedFrontMatter += `${key}: ${value}\n`;
      }
      updatedFrontMatter += '---\n\n';
      
      return updatedFrontMatter;
    });
  } else {
    // 创建新的front matter
    const frontMatter = `---
title: ${customFileName}
date: ${formattedDate}
tags: ${tags}
categories: ${categories}
---

`;
    // 将front matter添加到文件内容前
    newContent = frontMatter + contentWithImages;
  }
  
  // 确定最终的文件路径和操作类型
  let finalFilePath: string;
  let operationType: '更新' | '创建' = '创建';
  let finalDisplayName: string;
  
  if (existingFilePath) {
    // 更新已存在的文件
    finalFilePath = existingFilePath;
    finalDisplayName = existingFileName!;
    operationType = '更新';
  } else {
    // 创建新文件
    finalFilePath = path.join(targetDir, finalFileName);
    finalDisplayName = finalFileName;
  }
  
  // 写入文件
  await fs.writeFile(finalFilePath, newContent, 'utf-8');
  
  // 构建操作信息，包含图片处理信息
  const imageInfo = imageCount > 0 ? `，并处理了 ${imageCount} 张图片` : '';
  vscode.window.showInformationMessage(`已${operationType} ${finalDisplayName} 到${blogDirPath ? " " + blogDirPath + " 目录的" : ""}博客仓库${imageInfo}`);

  // 执行 Git 操作
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在${operationType}博客`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: '添加文件...' });
      await execAsync('git add .', { cwd: blogRepoPath });
      
      progress.report({ message: '提交变更...' });
      // 在提交信息中添加图片处理信息
      const commitMessage = imageCount > 0 
        ? `${operationType}: ${finalDisplayName} (含 ${imageCount} 张图片)`
        : `${operationType}: ${finalDisplayName}`;
        
      await execAsync(`git commit -m "${commitMessage}"`, { cwd: blogRepoPath });
      
      progress.report({ message: '推送到远程...' });
      try {
        // 获取代理端口配置
        const proxyPort = config.get<string>('proxyPort') || '';
        
        // 创建超时Promise
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Git push 超时')), 5000);
        });
        
        // 创建git push Promise
        const gitPush = new Promise<void>(async (resolve, reject) => {
          try {
            await execAsync('git push', { cwd: blogRepoPath });
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        
        // 使用Promise.race进行超时控制
        try {
          await Promise.race([gitPush, timeout]);
          vscode.window.showInformationMessage(`已成功${operationType} ${finalDisplayName} 到博客`);
        } catch (error) {
          console.log('Git push 超时或失败，尝试使用代理...');
          
          if (proxyPort) {
            try {
              // 设置代理环境变量
              const proxyCmd = `export https_proxy=http://127.0.0.1:${proxyPort} http_proxy=http://127.0.0.1:${proxyPort} all_proxy=socks5://127.0.0.1:${proxyPort}`;
              
              // 在设置代理的环境下执行git push
              await execAsync(`${proxyCmd} && git push`, { cwd: blogRepoPath, shell: '/bin/bash' });
              vscode.window.showInformationMessage(`已使用代理成功${operationType} ${finalDisplayName} 到博客`);
            } catch (proxyError) {
              throw proxyError; // 如果代理尝试也失败，则抛出错误
            }
          } else {
            throw error; // 如果没有配置代理端口，则抛出原始错误
          }
        }
      } catch (pushError) {
        console.error('Git push 失败:', pushError);
        const errorMessage = pushError instanceof Error ? pushError.message : String(pushError);
        
        // 询问用户是否要设置代理端口
        if (!config.get<string>('proxyPort')) {
          const setProxyChoice = await vscode.window.showErrorMessage(
            `推送到远程失败: ${errorMessage}`,
            '设置代理端口',
            '打开文件夹手动处理',
            '忽略'
          );
          
          if (setProxyChoice === '设置代理端口') {
            const proxyPortInput = await vscode.window.showInputBox({
              prompt: '请输入代理端口',
              placeHolder: '例如: 7890',
              ignoreFocusOut: true
            });
            
            if (proxyPortInput) {
              await config.update('proxyPort', proxyPortInput, vscode.ConfigurationTarget.Global);
              vscode.window.showInformationMessage(`已设置代理端口: ${proxyPortInput}，请重新尝试发布`);
              return;
            }
          } else if (setProxyChoice === '打开文件夹手动处理') {
            try {
              // 确保blogRepoPath不会为undefined
              if (blogRepoPath) {
                // 使用 code . 命令打开博客文件夹
                await execAsync(`code "${blogRepoPath}"`, { cwd: blogRepoPath });
                vscode.window.showInformationMessage(`已打开博客文件夹: ${blogRepoPath}，请手动推送到远程`);
              } else {
                vscode.window.showErrorMessage('博客仓库路径未设置');
              }
            } catch (openError) {
              console.error('打开文件夹失败:', openError);
              // 如果使用 code 命令失败且blogRepoPath存在，尝试直接在VS Code中打开文件夹
              if (blogRepoPath) {
                const uri = vscode.Uri.file(blogRepoPath);
                await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
              }
            }
          }
        } else {
          // 如果已经设置了代理但仍然失败
          const openFolderChoice = await vscode.window.showErrorMessage(
            `推送到远程失败: ${errorMessage}`,
            '打开文件夹手动处理',
            '忽略'
          );
          
          if (openFolderChoice === '打开文件夹手动处理') {
            try {
              // 确保blogRepoPath不会为undefined
              if (blogRepoPath) {
                // 使用 code . 命令打开博客文件夹
                await execAsync(`code "${blogRepoPath}"`, { cwd: blogRepoPath });
                vscode.window.showInformationMessage(`已打开博客文件夹: ${blogRepoPath}，请手动推送到远程`);
              } else {
                vscode.window.showErrorMessage('博客仓库路径未设置');
              }
            } catch (openError) {
              console.error('打开文件夹失败:', openError);
              // 如果使用 code 命令失败且blogRepoPath存在，尝试直接在VS Code中打开文件夹
              if (blogRepoPath) {
                const uri = vscode.Uri.file(blogRepoPath);
                await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Git 操作失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Git 操作失败: ${errorMessage}`);
      
      // 询问用户是否要打开博客文件夹手动处理
      const openFolderChoice = await vscode.window.showErrorMessage(
        '是否要打开博客文件夹手动处理?',
        '是',
        '否'
      );
      
      if (openFolderChoice === '是') {
        try {
          // 确保blogRepoPath不会为undefined
          if (blogRepoPath) {
            // 使用 code . 命令打开博客文件夹
            await execAsync(`code "${blogRepoPath}"`, { cwd: blogRepoPath });
            vscode.window.showInformationMessage(`已打开博客文件夹: ${blogRepoPath}，请手动处理`);
          } else {
            vscode.window.showErrorMessage('博客仓库路径未设置');
          }
        } catch (openError) {
          console.error('打开文件夹失败:', openError);
          // 如果使用 code 命令失败且blogRepoPath存在，尝试直接在VS Code中打开文件夹
          if (blogRepoPath) {
            const uri = vscode.Uri.file(blogRepoPath);
            await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
          }
        }
      }
    }
  });
}

// 分析Markdown内容以提取可能的标签和分类
async function analyzeContent(content: string, fileName: string): Promise<{ tags: string, categories: string }> {
  try {
    // 调用DeepSeek API来生成标签和分类
    const config = vscode.workspace.getConfiguration('publishBlog');
    const apiKey = config.get<string>('deepseekApiKey');
    
    if (!apiKey) {
      // 如果未设置API密钥，提示用户设置
      const inputApiKey = await vscode.window.showInputBox({
        prompt: '请输入DeepSeek API密钥',
        password: true,
        ignoreFocusOut: true
      });
      
      if (!inputApiKey) {
        throw new Error('需要DeepSeek API密钥');
      }
      
      // 保存API密钥
      await config.update('deepseekApiKey', inputApiKey, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('已保存DeepSeek API密钥');
    }
    
    // 获取最新的API密钥
    const deepseekApiKey = config.get<string>('deepseekApiKey');
    
    // 从TECH_KEYWORDS构建建议的技术词汇
    const suggestedTags: string[] = [];
    const suggestedCategories: string[] = Object.keys(TECH_KEYWORDS);
    
    for (const keywords of Object.values(TECH_KEYWORDS)) {
      suggestedTags.push(...keywords);
    }
    
    // 构建API请求
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一个面向程序员的技术内容分析助手。请分析文章内容并提供准确的技术相关标签和分类。标签和分类都必须限制在3个词以内，每个词都应该是前端/后端程序员使用的专业技术词汇，如算法、DOM、API、框架名称等技术术语，不要使用非技术性的普通词汇。请用英文逗号分隔各个词。'
          },
          {
            role: 'user',
            content: `请分析以下技术文章内容，给出不超过3个技术相关标签词和不超过3个技术相关分类词。这些词必须是专业的技术术语(如算法、DOM、React等)，而不是普通词汇。\n\n可供参考的标签词：${suggestedTags.join(', ')}\n可供参考的分类：${suggestedCategories.join(', ')}\n\n格式为：\n\n标签：技术词1, 技术词2, 技术词3\n分类：技术领域1, 技术领域2, 技术领域3\n\n标题：${fileName}\n\n${content.substring(0, 4000)}`
          }
        ],
        temperature: 0.3
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekApiKey}`
        }
      }
    );
    
    // 解析响应
    const aiResponse = response.data.choices[0].message.content;
    
    // 从AI响应中提取标签和分类
    const tagsMatch = aiResponse.match(/标签[：:]\s*(.*?)(?:\n|$)/i);
    const categoriesMatch = aiResponse.match(/分类[：:]\s*(.*?)(?:\n|$)/i);
    
    // 处理提取的标签和分类，确保不超过三个词
    const tags = tagsMatch ? 
      tagsMatch[1].split(/[,，]/).slice(0, 3).map((tag: string) => tag.trim()).join(', ') : 
      fileName;
      
    const categories = categoriesMatch ? 
      categoriesMatch[1].split(/[,，]/).slice(0, 3).map((category: string) => category.trim()).join(', ') : 
      '博客';
    
    return { tags, categories };
    
  } catch (error) {
    console.error('调用DeepSeek API失败:', error);
    // 回退到技术关键词匹配
    const lowerContent = content.toLowerCase();
    const detectedTags: Set<string> = new Set();
    const detectedCategories: Set<string> = new Set();
    
    // 优先从文件名中提取关键词
    for (const [category, keywords] of Object.entries(TECH_KEYWORDS)) {
      for (const keyword of keywords) {
        if (fileName.toLowerCase().includes(keyword)) {
          detectedTags.add(keyword);
          detectedCategories.add(category);
          break;
        }
      }
    }
    
    // 如果无法从文件名中提取，则从内容中提取
    if (detectedTags.size === 0) {
      for (const [category, keywords] of Object.entries(TECH_KEYWORDS)) {
        for (const keyword of keywords) {
          if (lowerContent.includes(keyword)) {
            detectedTags.add(keyword);
            if (!detectedCategories.has(category)) {
              detectedCategories.add(category);
            }
            if (detectedTags.size >= 3) {
              break;
            }
          }
        }
        if (detectedTags.size >= 3) {
          break;
        }
      }
    }
    
    // 如果仍然没有标签，使用默认值
    if (detectedTags.size === 0) {
      detectedTags.add(fileName.toLowerCase());
    }
    
    if (detectedCategories.size === 0) {
      detectedCategories.add('技术');
    }
    
    return {
      tags: Array.from(detectedTags).slice(0, 3).join(', '),
      categories: Array.from(detectedCategories).slice(0, 3).join(', ')
    };
  }
}

// 处理Markdown内容，替换特定的格式标记
function processMarkdownContent(content: string): string {
  // 替换 _**User**_ 为 Question：
  let processedContent = content.replace(/_\*\*User\*\*_/g, 'Question：');
  
  // 替换 _**Assistant**_ 为 Answer：
  processedContent = processedContent.replace(/_\*\*Assistant\*\*_/g, 'Answer：');
  
  return processedContent;
}

export function deactivate() {}

// Markdown 文件树数据提供器
class MarkdownTreeDataProvider implements vscode.TreeDataProvider<MarkdownTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MarkdownTreeItem | undefined | null | void> = new vscode.EventEmitter<MarkdownTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<MarkdownTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MarkdownTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MarkdownTreeItem): Promise<MarkdownTreeItem[]> {
    if (!element) {
      // 根级别，获取所有 Markdown 文件
      return this.getMarkdownFiles();
    }
    return [];
  }

  private async getMarkdownFiles(): Promise<MarkdownTreeItem[]> {
    const markdownFiles: MarkdownTreeItem[] = [];
    
    // 获取当前工作区中的 Markdown 文件
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        const pattern = new vscode.RelativePattern(folder, '**/*.md');
        const files = await vscode.workspace.findFiles(pattern);
        
        for (const file of files) {
          const fileName = path.basename(file.fsPath);
          const treeItem = new MarkdownTreeItem(
            fileName,
            file,
            vscode.TreeItemCollapsibleState.None
          );
          treeItem.command = {
            command: 'publish-blog.publish',
            title: '发布到博客',
            arguments: [file]
          };
          treeItem.contextValue = 'markdown';
          markdownFiles.push(treeItem);
        }
      }
    }
    
    return markdownFiles;
  }
}

// Markdown 树项目
class MarkdownTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
    this.description = path.relative(vscode.workspace.getWorkspaceFolder(this.resourceUri)?.uri.fsPath || '', this.resourceUri.fsPath);
  }

  iconPath = new vscode.ThemeIcon('markdown');

  contextValue = 'file';
}

// 处理Markdown中的图片，迁移到专用文件夹
async function processMarkdownImages(
  content: string, 
  srcFilePath: string, 
  targetDir: string, 
  fileName: string
): Promise<{ updatedContent: string, imageCount: number }> {
  console.log('开始处理Markdown中的图片引用');
  
  // 创建图片存储文件夹（和Markdown文件同名）
  const imagesFolderName = path.parse(fileName).name;
  const imagesFolderPath = path.join(targetDir, imagesFolderName);
  await fs.ensureDir(imagesFolderPath);
  
  console.log(`创建图片文件夹: ${imagesFolderPath}`);
  
  // 用于匹配Markdown中的图片引用
  // 匹配 ![alt](url) 或 ![alt](url "title")
  const imgRegex = /!\[(.*?)\]\((.*?)(?:\s+"(.*?)")?\)/g;
  
  let match;
  let updatedContent = content;
  const processedImages = new Set();
  let imageCount = 0;
  
  // 获取源文件所在目录（用于解析相对路径）
  const srcDir = path.dirname(srcFilePath);
  
  // 逐个处理图片引用
  while ((match = imgRegex.exec(content)) !== null) {
    const [fullMatch, altText, imgPath, title] = match;
    
    // 跳过已处理的图片（避免重复处理相同图片）
    if (processedImages.has(imgPath)) {
      continue;
    }
    
    processedImages.add(imgPath);
    console.log(`处理图片: ${imgPath}`);
    
    try {
      let newImagePath;
      
      // 判断是线上图片还是本地图片
      if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) {
        // 处理线上图片：下载并保存
        newImagePath = await downloadImage(imgPath, imagesFolderPath);
      } else {
        // 处理本地图片：复制到新位置
        newImagePath = await copyLocalImage(imgPath, srcDir, imagesFolderPath);
      }
      
      if (newImagePath) {
        // 生成新的图片引用路径（相对于博客文件的路径）
        const newImgRef = `${imagesFolderName}/${path.basename(newImagePath)}`;
        
        // 更新Markdown内容
        const titlePart = title ? ` "${title}"` : '';
        const newImgTag = `![${altText}](${newImgRef}${titlePart})`;
        updatedContent = updatedContent.replace(fullMatch, newImgTag);
        
        imageCount++;
      }
    } catch (error) {
      console.error(`处理图片失败 ${imgPath}:`, error);
    }
  }
  
  console.log(`图片处理完成，共处理 ${imageCount} 张图片`);
  return { updatedContent, imageCount };
}

// 下载线上图片
async function downloadImage(imageUrl: string, destFolder: string): Promise<string | null> {
  try {
    // 获取图片文件名
    const parsedUrl = url.parse(imageUrl);
    const imageName = path.basename(parsedUrl.pathname || '');
    
    // 如果URL没有文件扩展名，尝试从响应头获取
    let finalImageName = imageName;
    if (!path.extname(imageName)) {
      // 获取URL的响应头
      const response = await axios.head(imageUrl);
      const contentType = response.headers['content-type'];
      
      if (contentType) {
        const ext = contentType.split('/').pop();
        if (ext) {
          finalImageName = `${imageName || 'image'}.${ext}`;
        }
      }
    }
    
    // 确保文件名不为空且有效
    if (!finalImageName || finalImageName === '') {
      finalImageName = `image_${Date.now()}${path.extname(finalImageName) || '.jpg'}`;
    }
    
    // 构建保存路径
    const savePath = path.join(destFolder, finalImageName);
    
    console.log(`下载图片: ${imageUrl} -> ${savePath}`);
    
    // 下载图片
    const writer = fs.createWriteStream(savePath);
    
    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 30000, // 30秒超时
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(savePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`下载图片失败 ${imageUrl}:`, error);
    return null;
  }
}

// 复制本地图片
async function copyLocalImage(imagePath: string, srcDir: string, destFolder: string): Promise<string | null> {
  try {
    // 解析图片路径（可能是相对路径）
    const absoluteImagePath = path.isAbsolute(imagePath) 
      ? imagePath 
      : path.resolve(srcDir, imagePath);
    
    // 检查文件是否存在
    if (!fs.existsSync(absoluteImagePath)) {
      console.error(`本地图片不存在: ${absoluteImagePath}`);
      return null;
    }
    
    // 获取图片文件名
    const imageName = path.basename(absoluteImagePath);
    const destPath = path.join(destFolder, imageName);
    
    console.log(`复制本地图片: ${absoluteImagePath} -> ${destPath}`);
    
    // 复制图片
    await fs.copy(absoluteImagePath, destPath);
    
    return destPath;
  } catch (error) {
    console.error(`复制本地图片失败 ${imagePath}:`, error);
    return null;
  }
} 