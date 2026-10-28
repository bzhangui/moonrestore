// Original MoonRestore VSS requester. No service installation or elevation.
// A single, non-persistent, copy-backup snapshot set is owned by this process.
#define _WIN32_DCOM
#include <windows.h>
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>
#include <comdef.h>
#include <iostream>
#include <string>
#include <future>
#include <thread>
#include <memory>
#include <chrono>
#pragma comment(lib,"VssApi.lib")
#pragma comment(lib,"Ole32.lib")
#pragma comment(lib,"OleAut32.lib")
#pragma comment(lib,"Advapi32.lib")
static void check(HRESULT h){if(FAILED(h))throw h;}
static void waitVss(IVssAsync* a){
  if(!a)throw E_UNEXPECTED;
  HRESULT result=E_UNEXPECTED;
  HRESULT waited=a->Wait(180000);HRESULT queried=a->QueryStatus(&result,nullptr);
  if(waited==VSS_S_ASYNC_PENDING||result==VSS_S_ASYNC_PENDING)a->Cancel();
  a->Release();check(waited);check(queried);if(result!=VSS_S_ASYNC_FINISHED)throw E_FAIL;
}
static std::string utf8(const std::wstring& s){int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0,nullptr,nullptr);if(!n)throw E_INVALIDARG;std::string v(n,0);WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),(int)s.size(),v.data(),n,nullptr,nullptr);return v;}
static std::string json(const std::wstring& s){std::string r="\"";for(unsigned char c:utf8(s)){if(c=='"'||c=='\\')r+='\\';if(c<32)throw E_INVALIDARG;r+=(char)c;}return r+'"';}
static std::wstring guid(GUID value){wchar_t b[40];if(!StringFromGUID2(value,b,40))throw E_FAIL;return b;}
static unsigned health(IVssBackupComponents* c){
  IVssAsync* a=nullptr;check(c->GatherWriterStatus(&a));waitVss(a);UINT n=0;check(c->GetWriterStatusCount(&n));
  try{for(UINT i=0;i<n;i++){VSS_ID instance,id;BSTR name=nullptr;VSS_WRITER_STATE state;HRESULT failure;check(c->GetWriterStatus(i,&instance,&id,&name,&state,&failure));SysFreeString(name);if(FAILED(failure)||state==VSS_WS_UNKNOWN||state>=VSS_WS_FAILED_AT_IDENTIFY)throw E_FAIL;}}
  catch(...){c->FreeWriterStatus();throw;}
  check(c->FreeWriterStatus());if(!n)throw E_FAIL;return n;
}
int wmain(int argc,wchar_t** argv){
  if(argc==2&&std::wstring(argv[1])==L"--protocol"){std::cout<<"{\"protocol\":1,\"kind\":\"moonrestore_vss_requester\"}"<<std::endl;return 0;}
  if(argc!=2)return 2;
  IVssBackupComponents* c=nullptr;VSS_ID set=GUID_NULL,snapshot=GUID_NULL;bool com=false,done=false,removed=false;HRESULT failure=S_OK;
  try{
    // Refuse relative, UNC and device source paths; this helper never elevates.
    std::wstring source=argv[1];if(source.size()<3||source[1]!=L':'||source[2]!=L'\\'||source.size()>30000)throw E_INVALIDARG;
    wchar_t mount[MAX_PATH],volume[MAX_PATH];if(!GetVolumePathNameW(source.c_str(),mount,MAX_PATH)||!GetVolumeNameForVolumeMountPointW(mount,volume,MAX_PATH))throw E_FAIL;
    if(GetDriveTypeW(mount)!=DRIVE_FIXED)throw E_INVALIDARG;
    check(CoInitializeEx(nullptr,COINIT_MULTITHREADED));com=true;
    check(CoInitializeSecurity(nullptr,-1,nullptr,nullptr,RPC_C_AUTHN_LEVEL_PKT_PRIVACY,RPC_C_IMP_LEVEL_IDENTIFY,nullptr,EOAC_NONE,nullptr));
    check(CreateVssBackupComponents(&c));check(c->InitializeForBackup());check(c->SetContext(VSS_CTX_BACKUP));check(c->SetBackupState(FALSE,FALSE,VSS_BT_COPY,FALSE));
    IVssAsync* a=nullptr;check(c->GatherWriterMetadata(&a));waitVss(a);health(c);
    check(c->StartSnapshotSet(&set));
    std::cout<<"{\"phase\":\"intent\",\"set\":"<<json(guid(set))<<"}"<<std::endl;
    check(c->AddToSnapshotSet(volume,GUID_NULL,&snapshot));
    check(c->PrepareForBackup(&a));waitVss(a);health(c);
    check(c->DoSnapshotSet(&a));waitVss(a);unsigned writers=health(c);
    VSS_SNAPSHOT_PROP prop={};check(c->GetSnapshotProperties(snapshot,&prop));
    std::wstring device=prop.m_pwszSnapshotDeviceObject;VssFreeSnapshotProperties(&prop);
    std::cout<<"{\"phase\":\"ready\",\"set\":"<<json(guid(set))<<",\"snapshot\":"<<json(guid(snapshot))<<",\"device\":"<<json(device)<<",\"mount\":"<<json(mount)<<",\"writers\":"<<writers<<"}"<<std::endl;
    auto promise=std::make_shared<std::promise<std::string>>();auto input=promise->get_future();
    std::thread([promise](){std::string line;std::getline(std::cin,line);try{promise->set_value(line);}catch(...){} }).detach();
    if(input.wait_for(std::chrono::minutes(20))!=std::future_status::ready)throw E_ABORT;
    std::string command=input.get();
    if(command!="complete")throw E_ABORT;
    check(c->BackupComplete(&a));waitVss(a);health(c);done=true;
  }catch(HRESULT e){failure=e;}catch(...){failure=E_FAIL;}
  if(c){
    if(!done)c->AbortBackup();
    if(set!=GUID_NULL){LONG deleted=0;VSS_ID missed=GUID_NULL;HRESULT h=c->DeleteSnapshots(set,VSS_OBJECT_SNAPSHOT_SET,FALSE,&deleted,&missed);
      if(SUCCEEDED(h)&&missed==GUID_NULL){if(snapshot==GUID_NULL)removed=true;else{VSS_SNAPSHOT_PROP prop={};HRESULT exists=c->GetSnapshotProperties(snapshot,&prop);if(exists==VSS_E_OBJECT_NOT_FOUND)removed=true;else if(SUCCEEDED(exists))VssFreeSnapshotProperties(&prop);}}
    }else removed=true;
    c->FreeWriterMetadata();c->Release();
  }else removed=true;
  if(com)CoUninitialize();
  std::cout<<"{\"phase\":\"released\",\"completed\":"<<(done?"true":"false")<<",\"removed\":"<<(removed?"true":"false")<<",\"ok\":"<<(done&&removed&&SUCCEEDED(failure)?"true":"false")<<"}"<<std::endl;
  return done&&removed&&SUCCEEDED(failure)?0:1;
}
