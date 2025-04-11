#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 获取项目根目录
const rootDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(rootDir, 'package.json'));
const { name, version, publisher } = packageJson;

// VSIX文件名
const vsixFileName = `${publisher}.${name}-${version}.vsix`;
const vsixFilePath = path.join(rootDir, vsixFileName);

// 临时目录
const tempDir = path.join(rootDir, 'vsix-temp');
const extensionDir = path.join(tempDir, 'extension');

async function buildVsix() {
  try {
    console.log('开始生成VSIX文件...');
    
    // 清理之前的临时目录和VSIX文件
    if (fs.existsSync(tempDir)) {
      console.log('清理临时目录...');
      await fs.remove(tempDir);
    }
    if (fs.existsSync(vsixFilePath)) {
      console.log('移除旧的VSIX文件...');
      await fs.remove(vsixFilePath);
    }
    
    // 创建临时目录结构
    console.log('创建目录结构...');
    await fs.mkdirs(extensionDir);
    await fs.mkdirs(path.join(extensionDir, 'node_modules'));
    
    // 复制必要文件
    console.log('复制文件...');
    await fs.copy(path.join(rootDir, 'dist'), path.join(extensionDir, 'dist'));
    await fs.copy(path.join(rootDir, 'package.json'), path.join(extensionDir, 'package.json'));
    await fs.copy(path.join(rootDir, 'README.md'), path.join(extensionDir, 'README.md'));
    
    // 复制依赖
    console.log('复制依赖...');
    const dependencies = Object.keys(packageJson.dependencies || {});
    for (const dep of dependencies) {
      console.log(`  复制依赖: ${dep}`);
      await fs.copy(
        path.join(rootDir, 'node_modules', dep),
        path.join(extensionDir, 'node_modules', dep)
      );
    }
    
    // 创建zip文件
    console.log('创建VSIX文件...');
    process.chdir(tempDir);
    
    try {
      // 尝试使用系统zip命令
      await execAsync(`zip -r "${vsixFilePath}" *`);
      console.log('已使用系统zip命令创建VSIX文件');
    } catch (error) {
      console.error('系统zip命令失败，尝试使用内置zip...');
      // 如果系统zip命令失败，使用archiver库（需要先安装）
      const archiver = require('archiver');
      const output = fs.createWriteStream(vsixFilePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`已创建VSIX文件: ${vsixFilePath}`);
      });
      
      archive.pipe(output);
      archive.directory('extension/', 'extension');
      await archive.finalize();
    }
    
    // 清理临时目录
    console.log('清理临时文件...');
    await fs.remove(tempDir);
    
    console.log('=========================================');
    console.log(`VSIX文件已生成: ${vsixFilePath}`);
    console.log('安装方式: 在Cursor中使用命令"Extensions: Install from VSIX"进行安装');
    console.log('=========================================');
  } catch (error) {
    console.error('生成VSIX文件时出错:', error);
    process.exit(1);
  }
}

buildVsix(); 