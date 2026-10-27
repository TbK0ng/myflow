---
layout: home

hero:
  name: myflow
  text: 一个只跑在 Pi 上的工作流外壳
  tagline: 它替一次编码会话记住讲过的话、管住上下文、留下证据。这本书讲它怎么工作，为什么每个不寻常的选择都值得，以及它现在哪里还不够好。
  actions:
    - theme: brand
      text: 从「这是什么」开始
      link: /intro/what-is-myflow
    - theme: alt
      text: 直接看缺陷登记表
      link: /honest/defects
    - theme: alt
      text: GitHub
      link: https://github.com/TbK0ng/myflow

features:
  - title: 5 分钟
    details: 只读序和诚实篇。你会知道它解决什么问题、付出了什么代价、还有哪些洞没补。
    link: /intro/how-to-read
    linkText: 走这条路径
  - title: 30 分钟
    details: 加系统篇总览和两章论证。你会知道一次会话实际按什么顺序跑、状态落在哪些文件上。
    link: /system/overview
    linkText: 读系统篇
  - title: 上线篇
    details: 全书 33 页。代码之外的交付链路：怎么打包、怎么发布、出事了沿哪个文件查。每个维度先写真实状态，再写换一个形态要补什么。
    link: /launch/positioning
    linkText: 读上线篇
---

<div class="numbers">
  <span><b>33</b> 页</span>
  <span><b>8</b> 个 Pi hook</span>
  <span><b>7</b> 个工具</span>
  <span><b>2</b> 个斜杠命令</span>
  <span><b>12</b> 个 task.py 子命令</span>
  <span><b>8</b> 个随包发布的 skill</span>
  <span><b>38</b> 个测试文件</span>
  <span><b>3</b> 个提示模板</span>
</div>

## 这本书的主张

大多数 AI 编码工具把注意力放在"模型能写多少代码"上。myflow 关心的是另一件事：
**一次长会话能不能从头到尾说同一套话**。

它用三样东西回答这个问题——每轮注入的工作流状态、按字节预算裁剪的
任务上下文清单、以及一个需要人点头的计划批准门。三样都不新鲜，新鲜的是把它们
都做成了**磁盘上的文件**而不是进程里的状态：你可以 `cat` 它们、`grep` 它们、
在另一个终端里看它们。

第三部分会诚实交代这套做法的代价。比如这个项目**只支持 Windows + Git Bash**，
而这不是疏忽，是删掉两条没法测的代码路径之后的结果。
