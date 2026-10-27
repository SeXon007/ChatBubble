param([Parameter(Mandatory=$true)][string]$Exe, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
# Update only the newly packaged executable, never the Electron dependency.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AppIconResource {
  delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
  delegate bool LangCallback(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LangCallback callback, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool delete);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EndUpdateResource(IntPtr handle, bool discard);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Set(string exe, string icon) {
    byte[] ico = File.ReadAllBytes(icon);
    int count = BitConverter.ToUInt16(ico, 4);
    var groups = new List<Tuple<int, ushort>>();
    IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, 2);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      NameCallback names = (m,t,n,p) => {
        if (n.ToInt64() > 65535) throw new InvalidOperationException("Unexpected named icon group");
        LangCallback langs = (lm,lt,ln,l,lp) => { groups.Add(Tuple.Create(n.ToInt32(), l)); return true; };
        Check(EnumResourceLanguages(m,t,n,langs,IntPtr.Zero)); return true;
      };
      Check(EnumResourceNames(module, (IntPtr)14, names, IntPtr.Zero));
    } finally { FreeLibrary(module); }
    if (groups.Count == 0) throw new InvalidOperationException("No executable icon group found");
    IntPtr update = BeginUpdateResource(exe, false);
    if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool committed = false;
    try {
      foreach (var group in groups) {
        byte[] directory = new byte[6 + 14 * count];
        Buffer.BlockCopy(ico, 0, directory, 0, 6);
        for (int i=0; i<count; i++) {
          int entry = 6 + i*16, length = BitConverter.ToInt32(ico, entry+8), offset = BitConverter.ToInt32(ico, entry+12);
          byte[] png = new byte[length]; Buffer.BlockCopy(ico, offset, png, 0, length);
          Check(UpdateResource(update, (IntPtr)3, (IntPtr)(400+i), group.Item2, png, (uint)length));
          Buffer.BlockCopy(ico, entry, directory, 6+i*14, 12);
          Buffer.BlockCopy(BitConverter.GetBytes((ushort)(400+i)), 0, directory, 18+i*14, 2);
        }
        Check(UpdateResource(update, (IntPtr)14, (IntPtr)group.Item1, group.Item2, directory, (uint)directory.Length));
      }
      Check(EndUpdateResource(update, false)); committed = true;
    } finally { if (!committed) EndUpdateResource(update, true); }
  }
}
'@
[AppIconResource]::Set((Resolve-Path -LiteralPath $Exe).Path, (Resolve-Path -LiteralPath $Icon).Path)
