# Lab Note 软件署名与发布校验

软件作者：[LumyQAQ](https://github.com/LumyQAQ)。官方仓库：[LumyQAQ/Lab-Note](https://github.com/LumyQAQ/Lab-Note)。

工作台、分享页和 HTML 导出中的署名指软件作者。实验操作者及实验内容由记录使用者填写。
公开源码中的可见文字可以修改。软件发行使用独立 Ed25519 签名验证原始 ZIP 的完整性。

发布公钥指纹：`SHA256:RCyT74zgnkYtwaYpZoZAs3Uo0JhbyaeajnID3seH4hU`。

从官方仓库的同一版本取得 `docs/downloads/allowed_signers`、`lab-note-v1.7.1.zip.sig` 以及 ZIP，放在同一文件夹。请从作者控制的仓库核对公钥，不要直接信任第三方重打包附带的公钥。

```sh
ssh-keygen -Y verify -f allowed_signers -I LumyQAQ -n lab-note-release -s lab-note-v1.7.1.zip.sig < lab-note-v1.7.1.zip
```

在支持 SSH 签名的 OpenSSH 版本中，命令退出码 0 表示签名有效。也可用 `shasum -a 256 -c SHA256SUMS.txt` 核对文件摘要。

维护者重建 ZIP 后，在受控的 Mac 上签署新包，再发布对应公钥、签名和摘要：

```sh
ssh-keygen -Y sign -n lab-note-release -f "/path/to/release-signing-key" docs/downloads/lab-note-v1.7.1.zip
```
