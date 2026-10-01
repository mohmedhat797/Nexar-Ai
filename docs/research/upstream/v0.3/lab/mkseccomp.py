# Hand-assembled cBPF seccomp denylist (x86_64 only; demo). Output: raw sock_filter array for bwrap --seccomp FD.
import struct,sys
BPF_LD,BPF_W,BPF_ABS,BPF_JMP,BPF_JEQ,BPF_JSET,BPF_K,BPF_RET=0x00,0x00,0x20,0x05,0x10,0x40,0x00,0x06
def stmt(c,k): return struct.pack('<HBBI',c,0,0,k)
def jump(c,k,jt,jf): return struct.pack('<HBBI',c,jt,jf,k)
AUDIT_ARCH_X86_64=0xC000003E; EPERM=1; ERRNO=0x00050000; ALLOW=0x7FFF0000; KILL=0x80000000
deny=[272,308,425,426,427,101,248,249,250,165]  # unshare setns io_uring_{setup,enter,register} ptrace add_key request_key keyctl mount
ins=[]
ins.append(stmt(0x20,4))                       # ld arch
ins.append(jump(0x15,AUDIT_ARCH_X86_64,1,0))   # jeq arch -> next else kill
ins.append(stmt(0x06,KILL))
ins.append(stmt(0x20,0))                       # ld syscall nr
for n in deny:
    ins.append(jump(0x15,n,0,1)); ins.append(stmt(0x06,ERRNO|EPERM))
# clone(flags) with CLONE_NEWUSER (0x10000000) -> EPERM ; clone=56
ins.append(jump(0x15,56,0,3)); ins.append(stmt(0x20,16)); ins.append(jump(0x45,0x10000000,0,1)); ins.append(stmt(0x06,ERRNO|EPERM))
# NOTE: fallthrough after the clone block must reload nr? not needed: only allow below
ins.append(stmt(0x06,ALLOW))
open(sys.argv[1],'wb').write(b''.join(ins))
