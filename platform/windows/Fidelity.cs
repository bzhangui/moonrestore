// Original least-privilege helper. No privilege enabling, traversal or shell.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Numerics;
using Microsoft.Win32.SafeHandles;
class Fidelity {
  static string Step="input";
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StreamInfo {public long size;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)] public string name;}
  [StructLayout(LayoutKind.Sequential)] struct Range {public long offset;public long length;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStreamW(string file,int level,out StreamInfo data,int flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStreamW(IntPtr handle,out StreamInfo data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle file,uint code,IntPtr input,int inputSize,IntPtr output,int outputSize,out int returned,IntPtr overlap);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileTime(SafeFileHandle file,ref long creation,ref long access,ref long modified);
  static FileStream OpenStream(string p,bool write){SafeFileHandle h=CreateFileW(p,write?0xC0000000U:0x80000000U,7,IntPtr.Zero,write?4U:3U,0,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException("Stream open failed");}return new FileStream(h,write?FileAccess.ReadWrite:FileAccess.Read);}
  static byte[] ReadStream(string p){using(var f=OpenStream(p,false)){if(f.Length>65536)throw new IOException("Stream budget");byte[] bytes=new byte[(int)f.Length];int at=0;while(at<bytes.Length){int n=f.Read(bytes,at,bytes.Length-at);if(n==0)throw new IOException("Stream truncated");at+=n;}return bytes;}}
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer(){MaxJsonLength=1048576,RecursionLimit=20};
  static string Text(Dictionary<string,object> o,string k){return Convert.ToString(o[k]);}
  static bool IsDir(string p){return (File.GetAttributes(p)&FileAttributes.Directory)!=0;}
  static FileSystemSecurity Security(string p){return IsDir(p)?(FileSystemSecurity)Directory.GetAccessControl(p,AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group):File.GetAccessControl(p,AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);}
  static string EffectiveAcl(string sddl,bool directory){
    var raw=new RawSecurityDescriptor(sddl);
    // Freeze the archived effective deny/allow groups at the new location. Retain
    // OI/CI/IO/NP permissions; only the inherited-origin annotation is removed.
    // The original descriptor remains archived, not rewritten in the snapshot.
    if(raw.DiscretionaryAcl==null)throw new IOException("Null DACL profile unsupported");
    bool allowed=false;
    for(int i=0;i<raw.DiscretionaryAcl.Count;i++){
      var ace=raw.DiscretionaryAcl[i];
      // The ordinary A/D profile can canonicalize commutative same-kind runs.
      // Never reorder a deny behind an allow into a different access decision,
      // nor guess at callback/object/conditional ACE semantics.
      if(ace.AceType==AceType.AccessAllowed)allowed=true;
      else if(ace.AceType!=AceType.AccessDenied||allowed)throw new IOException("Complex or noncanonical effective ACL requires dedicated migration");
      ace.AceFlags &= ~AceFlags.Inherited;
    }
    raw.SetFlags((raw.ControlFlags|ControlFlags.DiscretionaryAclProtected)&~(ControlFlags.DiscretionaryAclAutoInherited|ControlFlags.DiscretionaryAclAutoInheritRequired));
    var canonical=new CommonSecurityDescriptor(directory,false,raw);
    return canonical.GetSddlForm(AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);
  }
  static List<object> Streams(string p){var result=new List<object>();StreamInfo info;IntPtr h=FindFirstStreamW(p,0,out info,0);if(h==new IntPtr(-1)){int e=Marshal.GetLastWin32Error();if(e==38||e==2)return result;throw new IOException("Named streams unavailable");}int total=0;try{do{if(info.name=="::$DATA")continue;if(!info.name.StartsWith(":")||!info.name.EndsWith(":$DATA"))throw new IOException("Unknown stream type");string name=info.name.Substring(1,info.name.Length-7);if(name.Length==0||name.Length>255||name.IndexOfAny(new char[]{':','/','\\','\0'})>=0||info.size<0||info.size>65536||(total+=checked((int)info.size))>65536||result.Count>=16)throw new IOException("ADS metadata budget");byte[] data=ReadStream(p+":"+name);if(data.Length!=info.size)throw new IOException("Stream changed");result.Add(new Dictionary<string,object>{{"name",name},{"data",Convert.ToBase64String(data)}});}while(FindNextStreamW(h,out info));if(Marshal.GetLastWin32Error()!=38)throw new IOException("Stream enumeration failed");}finally{FindClose(h);}return result;}
  static List<object> Ranges(string p,long size){var result=new List<object>();if(size==0)return result;using(var f=new FileStream(p,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)){var range=new Range(){offset=0,length=size};IntPtr input=Marshal.AllocHGlobal(16),output=Marshal.AllocHGlobal(65536);try{Marshal.StructureToPtr(range,input,false);int n;if(!DeviceIoControl(f.SafeFileHandle,0x940CF,input,16,output,65536,out n,IntPtr.Zero)||n%16!=0)throw new IOException("Sparse ranges unavailable or budget exceeded");for(int i=0;i<n;i+=16){Range r=(Range)Marshal.PtrToStructure(new IntPtr(output.ToInt64()+i),typeof(Range));if(r.offset<0||r.length<=0||r.offset>=size)throw new IOException("Invalid sparse range");result.Add(new string[]{r.offset.ToString(),Math.Min(r.length,size-r.offset).ToString()});}}finally{Marshal.FreeHGlobal(input);Marshal.FreeHGlobal(output);}}return result;}
  static DateTime Time(string value){BigInteger ns=BigInteger.Parse(value);if(ns%100!=0)throw new IOException("NTFS timestamp precision loss");BigInteger ticks=ns/100+621355968000000000L;return new DateTime((long)ticks,DateTimeKind.Utc);}
  static void Times(string p,Dictionary<string,object> m){
    // FILE_WRITE_ATTRIBUTES rather than GENERIC_WRITE also handles a read-only
    // file without clearing its archived read-only bit or enabling privileges.
    long creation=Time(Text(m,"birthtime_ns")).ToFileTimeUtc(),access=Time(Text(m,"atime_ns")).ToFileTimeUtc(),modified=Time(Text(m,"mtime_ns")).ToFileTimeUtc();
    using(var h=CreateFileW(p,0x100U,7,IntPtr.Zero,3U,0x02000000U,IntPtr.Zero)){
      if(h.IsInvalid||!SetFileTime(h,ref creation,ref access,ref modified))throw new IOException("Timestamp attributes unavailable");
    }
  }
  static void Check(string p){FileAttributes a=File.GetAttributes(p);if((a&(FileAttributes.ReparsePoint|FileAttributes.Encrypted|FileAttributes.Compressed))!=0)throw new IOException("Reparse/EFS/compressed metadata unsupported");}
  static object Capture(string p){Check(p);var a=File.GetAttributes(p);var s=Security(p);bool sparse=(a&FileAttributes.SparseFile)!=0;return new Dictionary<string,object>{{"platform","win32"},{"attributes",(int)a&8487},{"acl",s.GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group)},{"streams",Streams(p)},{"ranges",sparse&&!IsDir(p)?Ranges(p,new FileInfo(p).Length):null},{"sparse",sparse}};}
  static void Apply(string p,Dictionary<string,object> m){Check(p);var native=(Dictionary<string,object>)m["native"];bool permissions=(bool)m["permissions"];if(!permissions)throw new IOException("Explicit permission restoration required");
    Step="streams";
    File.SetAttributes(p,(FileAttributes)((int)File.GetAttributes(p)&~1));
    var expected=new Dictionary<string,byte[]>();foreach(Dictionary<string,object> stream in (IEnumerable)native["streams"]){string name=Text(stream,"name");if(name.Length==0||name.Length>255||name.IndexOfAny(new char[]{':','/','\\','\0'})>=0)throw new IOException("Unsafe stream");byte[] data=Convert.FromBase64String(Text(stream,"data"));if(data.Length>65536)throw new IOException("Stream budget");expected.Add(name,data);}
    foreach(Dictionary<string,object> stream in Streams(p)){if(!expected.ContainsKey(Text(stream,"name")))throw new IOException("Unexpected target ADS");}
    foreach(var pair in expected){string name=p+":"+pair.Key;using(var output=OpenStream(name,true)){if(output.Length>pair.Value.Length)throw new IOException("ADS target changed");byte[] existing=new byte[(int)output.Length];int read=0;while(read<existing.Length){int n=output.Read(existing,read,existing.Length-read);if(n==0)throw new IOException("ADS short read");read+=n;}for(int i=0;i<existing.Length;i++)if(existing[i]!=pair.Value[i])throw new IOException("ADS prefix changed");output.Position=existing.Length;output.Write(pair.Value,existing.Length,pair.Value.Length-existing.Length);output.Flush(true);}}
    File.SetAttributes(p,(FileAttributes)((int)File.GetAttributes(p)&~1));
    Step="security";FileSystemSecurity security=IsDir(p)?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();security.SetSecurityDescriptorSddlForm(EffectiveAcl(Text(native,"acl"),IsDir(p)),AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);if(IsDir(p))Directory.SetAccessControl(p,(DirectorySecurity)security);else File.SetAccessControl(p,(FileSecurity)security);
    Step="attributes";File.SetAttributes(p,(FileAttributes)Convert.ToInt32(native["attributes"]));
    Step="times";
    Times(p,m);
  }
  static int Main(){
    Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
    try{
      string input=Console.In.ReadToEnd();if(input.Length>1048576)throw new IOException("Input budget");
      var r=Json.Deserialize<Dictionary<string,object>>(input);string action=Text(r,"action");
      if(action=="probe"){Console.WriteLine(Json.Serialize(new {ok=true,protocol=1,platform="win32"}));return 0;}
      string p=Path.GetFullPath(Text(r,"path"));Check(p);object result=null;
      if(action=="capture")result=Capture(p);
      else if(action=="acl-normalize")result=EffectiveAcl(Text((Dictionary<string,object>)r["metadata"],"acl"),IsDir(p));
      else if(action=="times"){Step="times";Times(p,(Dictionary<string,object>)r["metadata"]);result=new {applied=true};}
      else if(action=="apply"){Apply(p,(Dictionary<string,object>)r["metadata"]);result=new {applied=true};}
      else if(action=="sparse"){
        using(var f=new FileStream(p,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete)){
          int n;if(!DeviceIoControl(f.SafeFileHandle,0x900C4,IntPtr.Zero,0,IntPtr.Zero,0,out n,IntPtr.Zero))throw new IOException("Sparse creation unavailable");
        }result=new {prepared=true};
      }else throw new IOException("Unknown capability");
      Console.WriteLine(Json.Serialize(new {ok=true,result=result}));return 0;
    }catch(Exception e){
      // A bounded type/stage code is diagnostic, never a path, SID or payload.
      Console.WriteLine(Json.Serialize(new {ok=false,error="Native fidelity refused",code=Step+":"+e.GetType().Name}));return 1;
    }
  }
}
