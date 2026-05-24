export async function getServerSideProps({ params }) {
  return {
    redirect: {
      destination: `/${params.organization}/dashboard`,
      permanent: false
    }
  };
}

export default function Index() {
  return null;
}
