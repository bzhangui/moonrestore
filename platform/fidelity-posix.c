#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#ifdef __APPLE__
#include <sys/acl.h>
#include <sys/time.h>
#endif
/* Bounded line protocol: hex avoids filename/value escaping and shell parsing.
 * Only a caller-validated individual path; never follows a final symlink. */
static int fail(void){fputs("fidelity capability/permission/budget rejected\n",stderr);return 2;}
static void hex(const unsigned char *p,size_t n){for(size_t i=0;i<n;i++)printf("%02x",p[i]);}
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static unsigned char *unhex(const char *s,size_t *n){size_t z=strlen(s);if(z%2||z>262144)return NULL;unsigned char *p=malloc(z/2+1);if(!p)return NULL;for(size_t i=0;i<z;i+=2){int a=digit(s[i]),b=digit(s[i+1]);if(a<0||b<0){free(p);return NULL;}p[i/2]=(unsigned char)(a*16+b);}*n=z/2;p[*n]=0;return p;}
/* A 64 KiB value would exceed Linux's single-argument limit after hex encoding.
 * Use bounded stdin, never an unbounded argv value or a shell. */
static char *input_hex(void){char *b=malloc(131074);if(!b)return NULL;if(!fgets(b,131074,stdin)){free(b);return NULL;}size_t n=strlen(b);if(!n||b[n-1]!='\n'||fgetc(stdin)!=EOF){free(b);return NULL;}b[n-1]=0;return b;}
static ssize_t names(const char *p,char *b,size_t n){
#ifdef __APPLE__
 return listxattr(p,b,n,XATTR_NOFOLLOW);
#else
 return llistxattr(p,b,n);
#endif
}
static ssize_t value(const char *p,const char *k,void *b,size_t n){
#ifdef __APPLE__
 return getxattr(p,k,b,n,0,XATTR_NOFOLLOW);
#else
 return lgetxattr(p,k,b,n);
#endif
}
static int put(const char *p,const char *k,const void *b,size_t n){
#ifdef __APPLE__
 return setxattr(p,k,b,n,0,XATTR_NOFOLLOW);
#else
 return lsetxattr(p,k,b,n,0);
#endif
}
int main(int argc,char **argv){
 if(argc==2&&!strcmp(argv[1],"probe")){puts("FIDELITY1");return 0;}
 if(argc<3)return fail();
 const char *action=argv[1],*p=argv[2];struct stat st;
 if(lstat(p,&st)||(!S_ISREG(st.st_mode)&&!S_ISDIR(st.st_mode)))return fail();
 if(!strcmp(action,"capture")){
  char keys[65536];ssize_t n=names(p,keys,sizeof(keys));if(n<0)return fail();size_t total=0;int count=0;
  for(ssize_t at=0;at<n;){size_t len=strnlen(keys+at,(size_t)(n-at));if(!len||at+(ssize_t)len>=n||++count>128)return fail();unsigned char data[65536];ssize_t bytes=value(p,keys+at,data,sizeof(data));if(bytes<0||(total+=(size_t)bytes)>131072)return fail();printf("X ");hex((unsigned char*)keys+at,len);printf(" ");hex(data,(size_t)bytes);puts("");at+=(ssize_t)len+1;}
#ifdef __APPLE__
  acl_t acl=acl_get_file(p,ACL_TYPE_EXTENDED);if(!acl)return fail();ssize_t size=0;char *text=acl_to_text(acl,&size);if(!text||size<0||size>65536){acl_free(acl);return fail();}printf("A ");hex((unsigned char*)text,(size_t)size);puts("");acl_free(text);acl_free(acl);
#endif
  if(S_ISREG(st.st_mode)&&st.st_size>0){int fd=open(p,O_RDONLY|O_NOFOLLOW);if(fd<0)return fail();off_t at=0;int ranges=0;while(at<st.st_size){errno=0;off_t data=lseek(fd,at,SEEK_DATA);if(data<0&&errno==ENXIO)break;if(data<0){close(fd);return fail();}off_t end=lseek(fd,data,SEEK_HOLE);if(end<=data||++ranges>4096){close(fd);return fail();}if(end>st.st_size)end=st.st_size;printf("R %lld %lld\n",(long long)data,(long long)(end-data));at=end;}close(fd);}puts("OK");return 0;
 }
 if(!strcmp(action,"xattr")&&(argc==4||argc==5)){size_t kn=0,vn=0;char *in=argc==4?input_hex():NULL;unsigned char *k=unhex(argv[3],&kn),*v=argc==5?unhex(argv[4],&vn):(in?unhex(in,&vn):NULL);free(in);if(!k||!v||!kn||kn>1024||memchr(k,0,kn)||vn>65536){free(k);free(v);return fail();}int ok=put(p,(char*)k,v,vn);free(k);free(v);if(ok)return fail();puts("OK");return 0;}
#ifdef __APPLE__
 if(!strcmp(action,"acl")&&(argc==3||argc==4)){size_t n=0;char *in=argc==3?input_hex():NULL;unsigned char *text=argc==4?unhex(argv[3],&n):(in?unhex(in,&n):NULL);free(in);if(!text||n>65536){free(text);return fail();}acl_t a=acl_from_text((char*)text);free(text);if(!a)return fail();int ok=acl_set_file(p,ACL_TYPE_EXTENDED,a);acl_free(a);if(ok)return fail();puts("OK");return 0;}
#endif
 if(!strcmp(action,"times")&&argc==5){struct timespec times[2];for(int i=0;i<2;i++){char *end=NULL;errno=0;long long ns=strtoll(argv[i+3],&end,10);if(errno==ERANGE||end==argv[i+3]||!end||*end)return fail();times[i].tv_sec=(time_t)(ns/1000000000LL);times[i].tv_nsec=(long)(ns%1000000000LL);if(times[i].tv_nsec<0){times[i].tv_nsec+=1000000000;times[i].tv_sec--;}}if(utimensat(AT_FDCWD,p,times,AT_SYMLINK_NOFOLLOW))return fail();puts("OK");return 0;}
 return fail();
}
